//! Screen-wide eyedropper. The main window hides, a PowerShell/WinForms overlay shows a frozen
//! capture of every monitor, and a left click copies that pixel as `#RRGGBB` to the clipboard.
//! Esc or any other click cancels.

use std::os::windows::process::CommandExt;
use std::process::Command;

use crate::CREATE_NO_WINDOW;

/// DPI-aware so the capture and click coordinates are physical pixels on scaled displays.
const SCRIPT: &str = r#"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace Kostomp -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'
[void][Kostomp.Dpi]::SetProcessDPIAware()
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$g.Dispose()
$f = New-Object System.Windows.Forms.Form
$f.FormBorderStyle = 'None'
$f.StartPosition = 'Manual'
$f.Bounds = $b
$f.TopMost = $true
$f.ShowInTaskbar = $false
$f.KeyPreview = $true
$f.BackgroundImage = $bmp
$f.BackgroundImageLayout = 'None'
$f.Cursor = [System.Windows.Forms.Cursors]::Cross
$global:hex = ''
$f.Add_MouseClick({ param($s, $e)
  if ($e.Button -eq 'Left') { $c = $bmp.GetPixel($e.X, $e.Y); $global:hex = '#{0:X2}{1:X2}{2:X2}' -f $c.R, $c.G, $c.B }
  $f.Close() })
$f.Add_KeyDown({ param($s, $e) if ($e.KeyCode -eq 'Escape') { $f.Close() } })
$f.Add_Shown({ $f.Activate() })
[void]$f.ShowDialog()
if ($global:hex) { [System.Windows.Forms.Clipboard]::SetText($global:hex); [Console]::Out.Write($global:hex) }
"#;

/// Returns the copied `#RRGGBB`, or `None` when the pick was cancelled.
#[tauri::command]
pub async fn pick_screen_color(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    // Hidden so colors under the Kostomp window can be picked too.
    let _ = window.hide();
    let picked = tauri::async_runtime::spawn_blocking(|| {
        Command::new("powershell")
            .args(["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-Command", SCRIPT])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
    })
    .await;
    let _ = window.show();
    let _ = window.set_focus();
    let out = picked.map_err(|e| e.to_string())?.map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    let hex = String::from_utf8_lossy(&out.stdout).trim().to_string();
    Ok((!hex.is_empty()).then_some(hex))
}
