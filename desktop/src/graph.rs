use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, ChildStderr, ChildStdin, ChildStdout, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct GraphBridge(Mutex<Option<GraphProcess>>);

/// Bytes of sidecar stderr kept for an error report: a startup failure prints its cause there.
const STDERR_TAIL: usize = 16 * 1024;

struct GraphProcess {
   child: Child,
   stdin: ChildStdin,
   stdout: BufReader<ChildStdout>,
   stderr: Receiver<String>,
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

/// Bun reports an uncaught failure as `error: ...` between a source excerpt and the stack.
fn failure_summary(stderr: &str) -> String {
   let lines: Vec<&str> = stderr.lines().map(str::trim).filter(|line| !line.is_empty()).collect();
   let errors: Vec<&str> = lines.iter().copied().filter(|line| line.starts_with("error:")).collect();
   let summary = if errors.is_empty() { &lines[lines.len().saturating_sub(3)..] } else { &errors[..] };
   summary.join(" ").chars().take(2048).collect()
}

impl GraphProcess {
   fn start(app: &AppHandle) -> Result<Self, String> {
      let data = app
         .path()
         .app_data_dir()
         .map_err(|error| error.to_string())?
         .join("graph");
      let mut child = crate::runtime::graph_command(&data)?
         .stdin(Stdio::piped())
         .stdout(Stdio::piped())
         .stderr(Stdio::piped())
         .spawn()
         .map_err(|error| format!("Could not start Graph: {error}"))?;
      let stdin = child.stdin.take().expect("piped Graph stdin");
      let stdout = BufReader::new(child.stdout.take().expect("piped Graph stdout"));
      let stderr = child.stderr.take().expect("piped Graph stderr");
      let (sender, receiver) = mpsc::channel();
      std::thread::spawn(move || {
         let _ = sender.send(stderr_tail(stderr));
      });
      Ok(Self { child, stdin, stdout, stderr: receiver })
   }

   fn request(&mut self, request: &Value) -> Result<Value, String> {
      writeln!(self.stdin, "{request}").map_err(|error| error.to_string())?;
      let mut line = String::new();
      if self
         .stdout
         .read_line(&mut line)
         .map_err(|error| error.to_string())?
         == 0
      {
         return Err("Graph sidecar exited before responding".into());
      }
      serde_json::from_str(&line).map_err(|error| error.to_string())
   }

   /// Close the pipes, wait for exit and summarize what the sidecar last wrote to stderr.
   fn stop(self) -> String {
      let Self { mut child, stdin, stdout, stderr } = self;
      drop(stdin);
      drop(stdout);
      let deadline = Instant::now() + Duration::from_secs(15);
      let mut exited = false;
      while Instant::now() < deadline {
         match child.try_wait() {
            Ok(Some(_)) => {
               exited = true;
               break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
         }
      }
      if !exited {
         crate::kill_tree(&mut child);
         let _ = child.wait();
      }
      // A surviving grandchild may still hold the pipe, so the report never waits long.
      stderr.recv_timeout(Duration::from_secs(2)).map(|text| failure_summary(&text)).unwrap_or_default()
   }
}

#[tauri::command]
pub async fn graph_request(app: AppHandle, request: Value) -> Result<Value, String> {
   tauri::async_runtime::spawn_blocking(move || {
      let bridge = app.state::<GraphBridge>();
      let mut slot = bridge.0.lock().map_err(|error| error.to_string())?;
      let process = match slot.as_mut() {
         Some(process) => process,
         None => slot.insert(GraphProcess::start(&app)?),
      };
      match process.request(&request) {
         Ok(response) => Ok(response),
         Err(error) => {
            let tail = slot.take().map(GraphProcess::stop).unwrap_or_default();
            Err(if tail.is_empty() { error } else { format!("{error}: {tail}") })
         }
      }
   })
   .await
   .map_err(|error| error.to_string())?
}

pub fn shutdown(app: &AppHandle) {
   if let Ok(mut slot) = app.state::<GraphBridge>().0.lock() {
      if let Some(process) = slot.take() {
         let _ = process.stop();
      }
   }
}
