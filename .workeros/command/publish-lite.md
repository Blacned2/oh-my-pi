---
description: Kostomp lite publish (only the shell, no omp/stats runtime) with auto version bump.
---

Run the Kostomp lite publish. Start it with project_start (name "publish-lite", cwd "desktop"), not with bash, because it takes several minutes:

`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1 -NoOmp -NoStats -Notes "latest" $ARGUMENTS`

Stop a running Kostomp app first, because it locks the build output. Follow the output with project_output until the process ends. Then report in Turkish: the version bump line, the installer path and size, and whether the update files were published. If the build fails, say so, and note that a retry needs `-NoBump` because the version was already raised. Do not commit.
