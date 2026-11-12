# Failure recovery

On a device advertising operation receipts, use `prepare_operation` before an
important authorized change supported by its schema. Pass the returned
`operation_id` to that change. Never invent an ID, use an expired ID, or treat
reserving an ID as permission to perform the operation.

After a timeout or disconnect, call `get_operation_status` with the original
device and operation ID. If the ID was lost, use `list_operations` and correlate
the receipt with the attempted change. Queries return stored state and safe
summaries; they do not execute the change again and may omit output or content.

For a device call without an operation receipt, use `get_call_status` with the
returned `support_id`, or `list_calls` if it was lost. Device call history does
not cover `list_devices`; refer to account activity for that support ID.
An `unknown` outcome remains uncertain. Inspect the relevant file, known job,
or browser session before considering a new action. If uncertainty remains,
explain it and ask before a potentially duplicate side effect.

- Authentication failure: direct the user to the RDH entry in the host's
  connector settings, or `/mcp` in Claude Code. Let the host manage OAuth. Do not read credentials,
  replay refresh tokens, or imply that the host supports RDH's optional
  refresh-recovery extension. A lost rotation response may require signing in again.
- Missing/offline device or revoked access: refresh `list_devices` and report
  the result. Do not switch identities or devices as a workaround.
- Permission or capability failure: explain the returned restriction. Do not
  bypass it with shell or another tool. Permission changes require an explicit
  request and the owner's supported management flow.
- Read-only connection failure: retry at most once after a short delay with
  the same bounded arguments and target; otherwise report the failure.
- Invalid read arguments: consult the current schema and correct the rejected
  field once. For `read_file`, omit `length` or use 1..65536 bytes. This does not
  permit retrying a potentially dispatched mutation.
- Stale file hash or existing-file conflict: reread and reconcile with current
  content. Never retry an overwrite using an empty `expected_sha256`.
- Busy service or unknown write outcome: retry a change only with evidence it
  was not dispatched, or after state inspection and authorization for the new
  action. Never replay browser submissions or one-use upload grants.
- `payment_required`: stop retrying. `get_billing_status` can report entitlement
  and remaining allowance. Explain observed values without initiating checkout,
  promoting plans, following payment links, or promising a refund/free retry.

Report authentication, host loading, routing, and device errors separately.
Do not interpret an empty device list as a connection failure or a missing
browser tool as an Agent crash.
