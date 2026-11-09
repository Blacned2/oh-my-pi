use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::Value;
use tauri::{AppHandle, Manager};

#[derive(Default)]
pub struct GraphBridge(Mutex<Option<GraphProcess>>);

struct GraphProcess {
   child: Child,
   stdin: ChildStdin,
   stdout: BufReader<ChildStdout>,
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
         .stderr(Stdio::null())
         .spawn()
         .map_err(|error| format!("Could not start Graph: {error}"))?;
      let stdin = child.stdin.take().expect("piped Graph stdin");
      let stdout = BufReader::new(child.stdout.take().expect("piped Graph stdout"));
      Ok(Self { child, stdin, stdout })
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

   fn stop(self) {
      let Self { mut child, stdin, stdout } = self;
      drop(stdin);
      drop(stdout);
      let deadline = Instant::now() + Duration::from_secs(15);
      while Instant::now() < deadline {
         match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(_) => break,
         }
      }
      crate::kill_tree(&mut child);
      let _ = child.wait();
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
      let response = process.request(&request);
      if response.is_err() {
         if let Some(process) = slot.take() {
            process.stop();
         }
      }
      response
   })
   .await
   .map_err(|error| error.to_string())?
}

pub fn shutdown(app: &AppHandle) {
   if let Ok(mut slot) = app.state::<GraphBridge>().0.lock() {
      if let Some(process) = slot.take() {
         process.stop();
      }
   }
}
