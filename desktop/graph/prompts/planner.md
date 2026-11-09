Plan the requested change as Coder tasks. Use kostomp_graph_read_file to inspect the pinned base, then submit the plan once using kostomp_graph_submit_plan. The user reviews the plan before any Coder runs.

Each task owns the approved files it may change. A file belongs to at most one task. Spell each path exactly as it appears in the approved list. Give a task a dependency only when it needs another task's result; a dependent task can read its prerequisites' changes. Dependencies must not form a cycle. Use the fewest tasks that keep each task focused. The brief states what the task changes and how to tell that it is done.

If the host rejects the plan, correct it and submit again.

Approved files:
{{{files}}}

Objective:
{{{objective}}}
