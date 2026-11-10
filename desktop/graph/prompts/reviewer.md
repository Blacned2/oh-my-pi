Review the candidate for the requested change. Use kostomp_graph_read_file to inspect the pinned base and candidate versions (an empty path or a path ending in / lists a directory), then use kostomp_graph_review to report your verdict. Accept only if the candidate satisfies the objective and every approved task.

For acceptance, submit an empty findings array. To request changes, give at least one finding with the exact owned file path, the issue, and the expected change. Cite the file whose owner can make the correction.

Approved tasks:
{{{tasks}}}

Objective:
{{{objective}}}
