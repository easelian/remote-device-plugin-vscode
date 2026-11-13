# Operation receipts and recovery

On devices advertising `operation_receipts`, the Hub records a receipt for a
supported change whether or not an ID was reserved. Reserving one first with
`prepare_operation` means the ID is already known if the execution response is
lost. Without it, recovery depends on an ID returned with the result or error,
or on correlating a receipt from `list_operations`.

Reserve an ID when the task needs to establish what the call itself did, not
only what state exists now: `start_process`, `write_process_stdin`,
`terminate_process`, `browser_open`, `browser_act`, `browser_control`, and a
file change that triggers further effects or whose final state cannot be read
back reliably. For an ordinary file change where only the final content matters
and it is verified by reading back, the reservation may be skipped. Skipping it
never permits a blind retry: after a lost response, use the receipt, call
history, or state inspection first, and do not repeat a change whose outcome is
uncertain.

1. Call `prepare_operation` with `device_id` and `operation`: the target tool's
   exact name from the current enum, without a host-added namespace. Read-only
   tools are not supported. Preparation does not execute the change or grant permission.
2. Pass the returned `operation_id` unchanged to that tool on the same device,
   along with its required arguments. For example, `start_process` also needs
   the selected `root` and authorized `command`. Never invent an ID. The returned
   `expires_at` gives the receipt's expiry; do not derive it from device settings.
3. If the execution response is lost or times out, call `get_operation_status`
   with the original device and operation ID. If the ID was lost, correlate a
   receipt from `list_operations`. These queries return stored state and bounded
   summaries, may omit output or content, and do not execute the change again.

Apply the receipt flow only when both the tool and device support it. Lack of
receipt support is distinct from a rejected preparation request: do not drop
the ID or bypass a denial to force a change through.

For a device call without an operation receipt, use `get_call_status` with the
returned `support_id`, or `list_calls` if it was lost. Device call history does
not cover `list_devices`; refer to account activity for that support ID.
An `unknown` outcome remains uncertain. Inspect the relevant file, known job,
or browser session before considering a new action. If uncertainty remains,
explain it and ask before a potentially duplicate side effect.

- Authentication failure: sign in again the way the connection step in
  `SKILL.md` describes for this host. Do not read credentials or replay refresh
  tokens. A lost rotation response may require signing in again.
- Missing/offline device or revoked access: refresh `list_devices` and report
  the result. Do not switch identities or devices as a workaround.
- Permission or capability failure: explain the returned restriction. Do not
  bypass it with shell or another tool. Permission changes require an explicit
  request and the owner's supported management flow.
- Read-only connection failure: retry at most once after a short delay with
  the same bounded arguments and target; otherwise report the failure.
- Schema validation rejected before dispatch: inspect the current schema and
  correct missing or misnamed fields once. Correct a change only when the
  rejection establishes that it was not dispatched; an ambiguous error or
  timeout requires recovery first.
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
