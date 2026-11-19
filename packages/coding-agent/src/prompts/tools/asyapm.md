AsyaPM issues (tasks) across configured organizations; each organization has its own token.
`orgs`: configured organizations.
`projects`: projects the token can see.
`board`: project board columns with canonical status names and `statusIds` — source of `status_id` for `set_status`.
`issues`: list, newest-updated first; filters `project_id`, `status` (comma-separated canonical names, e.g. `To Do,In Progress`), `label`; paging `page`, `page_size` (max 200).
`issue`: one issue with description and comments; embedded images come attached, marked `[Görsel N]` in the text.
`set_status`: move `issue_id` to `status_id`; workflow rules apply, invalid transitions fail.
`comment`: add plain-text `body` to `issue_id`; visible to the whole team.
`org` REQUIRED when more than one organization is configured.
Issues are addressed by numeric `issue_id`, not key; find it with `issues`.
NEVER `set_status` or `comment` unless the user asked for it or the task workflow clearly calls for it.
