//! Where `omp` and the stats dashboard come from.
//!
//! The installer bundles a `runtime/` folder (bun.exe + the omp built from THIS repository's
//! `packages/`, see scripts/stage-runtime.ps1). The omp installed on the machine is never used.
//! Resolution order for omp, first hit wins:
//!   1. KOSTOMP_OMP  - explicit developer override
//!   2. the bundled runtime next to the app
//! The stats dashboard additionally accepts KOSTOMP_STATS_ENTRY and falls back to the global install.

use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

use crate::CREATE_NO_WINDOW;

/// Each part is bundled independently: the installer may leave either one out.
struct Bundled {
    bun: PathBuf,
    cli: Option<PathBuf>,
    stats: Option<PathBuf>,
}

static BUNDLED: OnceLock<Option<Bundled>> = OnceLock::new();

/// `dir` is the bundled `runtime` folder; without its bun.exe nothing is bundled.
pub fn init(dir: &Path) {
    let bun = dir.join("bun.exe");
    let part = |rel: &str| Some(dir.join(rel)).filter(|p| p.is_file());
    let bundled = bun.is_file().then(|| Bundled {
        bun,
        cli: part("node_modules/@oh-my-pi/pi-coding-agent/src/cli.ts"),
        stats: part("node_modules/@oh-my-pi/omp-stats/src/index.ts"),
    });
    let _ = BUNDLED.set(bundled);
}

fn bundled() -> Option<&'static Bundled> {
    BUNDLED.get().and_then(|b| b.as_ref())
}

/// A command that runs `omp`; the caller appends its arguments.
pub fn omp_command() -> Result<Command, String> {
    let embedded = bundled().and_then(|b| b.cli.as_ref().map(|cli| (&b.bun, cli)));
    let mut cmd = match (std::env::var("KOSTOMP_OMP"), embedded) {
        (Ok(path), _) => Command::new(path),
        (_, Some((bun, cli))) => {
            let mut c = Command::new(bun);
            c.arg(cli);
            c
        }
        _ => return Err("omp is not bundled with this app; rebuild it (scripts/stage-runtime.ps1) or set KOSTOMP_OMP".into()),
    };
    cmd.creation_flags(CREATE_NO_WINDOW);
    Ok(cmd)
}

/// A command that starts the stats server; the caller appends `--port`.
pub fn stats_command() -> (Command, PathBuf) {
    let override_entry = std::env::var("KOSTOMP_STATS_ENTRY").ok().map(PathBuf::from);
    let embedded = bundled().and_then(|b| b.stats.as_ref().map(|stats| (&b.bun, stats)));
    let (mut cmd, entry) = match (override_entry, embedded) {
        (Some(entry), _) => (global_bun(), entry),
        (None, Some((bun, stats))) => (Command::new(bun), stats.clone()),
        (None, None) => {
            let home = std::env::var("USERPROFILE").unwrap_or_default();
            let entry = PathBuf::from(home)
                .join(".bun/install/global/node_modules/@oh-my-pi/omp-stats/src/index.ts");
            (global_bun(), entry)
        }
    };
    cmd.arg(&entry);
    cmd.creation_flags(CREATE_NO_WINDOW);
    (cmd, entry)
}

/// `bun` may be an npm .cmd shim, which only cmd.exe can launch.
fn global_bun() -> Command {
    let mut c = Command::new("cmd");
    c.args(["/C", "bun"]);
    c
}
