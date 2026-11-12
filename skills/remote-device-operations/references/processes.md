# Commands and managed jobs

Check `allow_shell` and the limits returned by `device_info`. Specify the
selected root and working directory explicitly. Do not infer that a command is
confined to a file root: it can access whatever the Agent OS account can access.
Do not use privilege escalation, install software, contact external systems,
or modify unrelated files unless covered by the user's request.

Use `start_process` for an authorized command. The result includes a `job_id`
and initial output. Use `read_process` until completion, following `next_offset`;
its offsets count Unicode characters, unlike file-read offsets. Report
`output_dropped` if the ring buffer discarded output. Inspect the actual status
and exit code before claiming success. Do not launch a second job to poll the first.

These jobs are not PTYs. `write_process_stdin` can send input or EOF to a managed
job; that input can itself authorize or trigger changes, so apply the same
authorization boundary as for the command. Do not send an approval response
automatically to an unexpected interactive prompt.

`list_processes` lists this Agent's managed jobs, not all system processes.
`terminate_process` immediately kills a managed process group and can lose work.
Confirm the exact job and consequence unless the user has already authorized
that termination. It cannot be used with an arbitrary system PID.
