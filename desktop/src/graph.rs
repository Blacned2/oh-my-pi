use std::io::{BufRead, BufReader, Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Mutex, MutexGuard, PoisonError};
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct GraphBridge {
   /// Serializes requests; held while a request waits for its answer.
   io: Mutex<Option<GraphIo>>,
   /// Kept apart from `io` so `shutdown` never waits behind a request in flight.
   process: Mutex<Option<Sidecar>>,
   closing: AtomicBool,
}

/// Bytes of sidecar stderr kept for an error report: a startup failure prints its cause there.
const STDERR_TAIL: usize = 16 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// `edit` and `delete` wait in the sidecar for running work to settle.
const WORK_TIMEOUT: Duration = Duration::from_secs(300);
/// Time a sidecar gets to exit after its stdin closes before it is killed.
const STOP_GRACE: Duration = Duration::from_secs(5);
const SHUTTING_DOWN: &str = "Graph is shutting down";

struct GraphIo {
   stdout: Receiver<Result<String, String>>,
   stderr: Receiver<String>,
}

struct Sidecar {
   child: Child,
   /// Lines for the writer thread; dropping it closes the sidecar's stdin.
   input: Sender<String>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
   mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

/// Drain stderr so the sidecar never blocks on a full pipe, keeping only the last bytes.
fn stderr_tail(mut pipe: ChildStderr) -> String {
   let mut tail = Vec::new();
   let mut buffer = [0u8; 4096];
   while let Ok(read) = pipe.read(&mut buffer) {
      if read == 0 {
         break;
      }
      tail.extend_from_slice(&buffer[..read]);
      if tail.len() > STDERR_TAIL {
         tail.drain(..tail.len() - STDERR_TAIL);
      }
   }
   String::from_utf8_lossy(&tail).into_owned()
}

/// Forward stdout lines until EOF; the channel disconnects when the sidecar is gone.
fn read_lines(pipe: ChildStdout, lines: Sender<Result<String, String>>) {
   let mut reader = BufReader::new(pipe);
   loop {
      let mut line = String::new();
      let item = match reader.read_line(&mut line) {
         Ok(0) => return,
         Ok(_) => Ok(line),
         Err(error) => Err(error.to_string()),
      };
      let failed = item.is_err();
      if lines.send(item).is_err() || failed {
         return;
      }
   }
}

/// A write blocks while the sidecar does not read, so it never runs under a lock.
fn write_lines(mut pipe: ChildStdin, lines: Receiver<String>) {
   for line in lines {
      if pipe.write_all(line.as_bytes()).is_err() {
         return;
      }
   }
}

/// Bun reports an uncaught failure as `error: ...` between a source excerpt and the stack.
fn failure_summary(stderr: &str) -> String {
   let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
   let errors: Vec<&str> = lines.iter().copied().filter(|line| line.starts_with("error:")).collect();
   let summary = if errors.is_empty() { &lines[lines.len().saturating_sub(3)..] } else { &errors[..] };
   summary.join(" ").chars().take(2048).collect()
}

/// A bad line leaves the framing intact, so the sidecar is kept.
fn parse_response(line: &str) -> Result<Value, String> {
   const INVALID: &str = "Graph sidecar sent an invalid response";
   let response: Value = serde_json::from_str(line).map_err(|error| format!("{INVALID}: {error}"))?;
   if response.get("ok").is_some_and(Value::is_boolean) {
      Ok(response)
   } else {
      Err(format!("{INVALID}: expected an object with a boolean `ok`"))
   }
}

/// Graph data (SQLite in WAL mode, this machine's paths) must not roam, so it lives in the local
/// profile. Data from before that is moved over by one directory rename. A rename that fails (a
/// file held by another instance, another volume) keeps the roaming directory for this start and
/// is tried again at the next, so there is never a partial copy.
fn data_dir(local: PathBuf, roaming: PathBuf) -> PathBuf {
   if local.exists() || !roaming.exists() {
      return local;
   }
   let moved = local.parent().map_or(Ok(()), std::fs::create_dir_all).and_then(|()| std::fs::rename(&roaming, &local));
   if moved.is_ok() { local } else { roaming }
}

impl Sidecar {
   /// Close stdin, give the sidecar `grace` to exit, then kill its process tree.
   fn stop(self, grace: Duration) {
      let Self { mut child, input } = self;
      drop(input);
      let deadline = Instant::now() + grace;
      loop {
         match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => break,
         }
      }
      crate::kill_tree(&mut child);
      let _ = child.wait();
   }
}

impl GraphBridge {
   /// Spawn the sidecar; called with `io` held and both slots empty.
   fn start(&self, app: &AppHandle) -> Result<GraphIo, String> {
      let path = app.path();
      let local = path.app_local_data_dir().map_err(|error| error.to_string())?.join("graph");
      let roaming = path.app_data_dir().map_err(|error| error.to_string())?.join("graph");
      let data = data_dir(local, roaming);
      std::fs::create_dir_all(&data).map_err(|error| format!("Could not create the Graph data directory: {error}"))?;
      // Never cleared here: the sidecar removes leftovers once it holds the data-directory lease.
      let scratch = std::env::temp_dir().join("kostomp-graph-scratch");
      std::fs::create_dir_all(&scratch).map_err(|error| format!("Could not create the Graph scratch directory: {error}"))?;
      let mut child = crate::runtime::graph_command(&data)?
         .current_dir(&data)
         .env("TEMP", &scratch)
         .env("TMP", &scratch)
         .env("KOSTOMP_GRAPH_SCRATCH", &scratch)
         .stdin(Stdio::piped())
         .stdout(Stdio::piped())
         .stderr(Stdio::piped())
         .spawn()
         .map_err(|error| format!("Could not start Graph: {error}"))?;
      let stdin = child.stdin.take().expect("piped Graph stdin");
      let stdout = child.stdout.take().expect("piped Graph stdout");
      let stderr = child.stderr.take().expect("piped Graph stderr");
      let (stderr_sender, stderr_receiver) = mpsc::channel();
      std::thread::spawn(move || {
         let _ = stderr_sender.send(stderr_tail(stderr));
      });
      let (line_sender, line_receiver) = mpsc::channel();
      std::thread::spawn(move || read_lines(stdout, line_sender));
      let (input, input_receiver) = mpsc::channel();
      std::thread::spawn(move || write_lines(stdin, input_receiver));
      let sidecar = Sidecar { child, input };
      let mut process = lock(&self.process);
      // `shutdown` sets the flag before it takes the slot, so a sidecar inserted here is always seen.
      if self.closing.load(Ordering::SeqCst) {
         drop(process);
         sidecar.stop(Duration::ZERO);
         return Err(SHUTTING_DOWN.into());
      }
      *process = Some(sidecar);
      Ok(GraphIo { stdout: line_receiver, stderr: stderr_receiver })
   }

   fn request(&self, app: &AppHandle, request: &Value) -> Result<Value, String> {
      if self.closing.load(Ordering::SeqCst) {
         return Err(SHUTTING_DOWN.into());
      }
      let mut io = lock(&self.io);
      // `shutdown` stopped the sidecar without touching `io`.
      if io.is_some() && lock(&self.process).is_none() {
         *io = None;
      }
      let pipes = match io.as_mut() {
         Some(pipes) => pipes,
         None => io.insert(self.start(app)?),
      };
      let timeout = match request["op"].as_str() {
         Some("edit" | "delete") => WORK_TIMEOUT,
         _ => REQUEST_TIMEOUT,
      };
      // Requests are serialized and answered with one line each, so a line already waiting answers nothing.
      while pipes.stdout.try_recv().is_ok() {}
      let sent = lock(&self.process).as_ref().map(|sidecar| sidecar.input.send(format!("{request}\n")).is_ok());
      let (error, grace) = match sent {
         None => {
            *io = None;
            return Err(SHUTTING_DOWN.into());
         }
         Some(false) => ("Graph sidecar stopped reading requests".to_string(), STOP_GRACE),
         Some(true) => match pipes.stdout.recv_timeout(timeout) {
            Ok(Ok(line)) => return parse_response(&line),
            Ok(Err(error)) => (format!("Could not read the Graph sidecar's answer: {error}"), STOP_GRACE),
            Err(RecvTimeoutError::Disconnected) => ("Graph sidecar exited before responding".to_string(), STOP_GRACE),
            Err(RecvTimeoutError::Timeout) => {
               (format!("Graph sidecar did not answer within {} s", timeout.as_secs()), Duration::ZERO)
            }
         },
      };
      // `io` stays held while the old sidecar stops, so no request respawns over its data-directory lease.
      let pipes = io.take().expect("Graph pipes");
      let sidecar = lock(&self.process).take();
      if let Some(sidecar) = sidecar {
         sidecar.stop(grace);
      }
      if self.closing.load(Ordering::SeqCst) {
         return Err(SHUTTING_DOWN.into());
      }
      // A surviving grandchild may still hold the pipe, so the report never waits long.
      let tail = pipes
         .stderr
         .recv_timeout(Duration::from_secs(2))
         .map(|text| failure_summary(&text))
         .unwrap_or_default();
      Err(if tail.is_empty() { error } else { format!("{error}: {tail}") })
   }
}

#[tauri::command]
pub async fn graph_request(app: AppHandle, request: Value) -> Result<Value, String> {
   tauri::async_runtime::spawn_blocking(move || app.state::<GraphBridge>().request(&app, &request))
      .await
      .map_err(|error| error.to_string())?
}

/// Stops the sidecar and refuses new requests until `reopen`.
pub fn shutdown(app: &AppHandle) {
   let bridge = app.state::<GraphBridge>();
   bridge.closing.store(true, Ordering::SeqCst);
   let sidecar = lock(&bridge.process).take();
   if let Some(sidecar) = sidecar {
      sidecar.stop(STOP_GRACE);
   }
}

/// Lets Graph start again after `shutdown` when the app keeps running (a failed update install).
pub fn reopen(app: &AppHandle) {
   app.state::<GraphBridge>().closing.store(false, Ordering::SeqCst);
}
