---
description: Kostomp full publish (shell + omp + stats runtime) with auto version bump.
---

Run the Kostomp full publish. Start it with project_start (name "publish-full", cwd "desktop"), not with bash, because it takes several minutes:

`powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build-installer.ps1 -Notes "latest" $ARGUMENTS`

Stop a running Kostomp app first, because it locks the build output. Follow the output with project_output until the process ends. Then report in Turkish: the version bump line, the installer path and size, and whether the update files were published. If the build fails, say so, and note that a retry needs `-NoBump` because the version was already raised. Do not commit.
