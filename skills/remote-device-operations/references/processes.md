# Commands and managed jobs

Check `allow_shell` and the limits returned by `device_info`. `start_process`
requires a named `root` from that device even when `cwd` is omitted or `"."`.
Set `cwd` relative to that root when the command needs a particular directory.
The command can access whatever the Agent OS account can access; its working
directory does not confine it to a file root.
Do not use privilege escalation, install software, contact external systems,
or modify unrelated files unless covered by the user's request.

Use `start_process` for an authorized command and retain its returned `job_id`.
A successful start receipt covers the start call; it does not establish the
command's exit status. `wait_seconds` bounds only the initial response wait:
0 to 5 seconds, default 1. It cannot wait out a long command. `timeout_seconds`
limits job runtime: at least 1 and at most the `max_process_seconds` returned
by `device_info`. The default is 300. On a device whose maximum is lower, pass
an explicit value within that maximum instead of relying on the default.
A job can still be running when the initial wait ends.

When the task requires the command result, use `read_process` until a terminal
status is observed, following `next_offset` and backing off when output is
unchanged. Inspect status and exit code before claiming success. For a request
only to launch a background job, report its ID and observed state. If completion
cannot be verified, report it as pending or unknown. Never start another job
to poll or replace the first after a lost response.

Process offsets count Unicode characters, unlike file-read byte offsets.
Report `output_dropped` if the ring buffer discarded output.

These jobs are not PTYs. `write_process_stdin` can send input or EOF to a managed
job; that input can itself authorize or trigger changes, so apply the same
authorization boundary as for the command. Do not send an approval response
automatically to an unexpected interactive prompt.

`list_processes` lists this Agent's managed jobs, not all system processes.
`terminate_process` immediately kills a managed process group and can lose work.
Confirm the exact job and consequence unless the user has already authorized
that termination. It cannot be used with an arbitrary system PID.
