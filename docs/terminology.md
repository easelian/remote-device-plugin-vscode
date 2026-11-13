# Remote Device Hub terminology

Remote Device Hub (RDH) is the Easelian product. Remote Device Agent (Agent) is the native program `rdh` running on a device. A client plugin or extension connects an AI host to RDH and supplies host-specific integration and operating guidance.

| Term | Meaning |
| --- | --- |
| Pairing / binding | Pairing is the approval flow; a binding is the resulting saved device identity and configuration. Unbinding revokes device access. |
| Authorization / local policy | RDH checks account and device access; Agent policy limits operations on the device. Client approval prompts are an additional host control. |
| File root / shared directory | A named file-tool boundary. Shell commands run with the Agent OS account's permissions; file roots do not sandbox commands. |
| Allowance | The call budget of the account's plan. `get_billing_status` reports what remains. Resource limits on the Agent are separate. |
| Operation / receipt / managed job | An operation has a stable operation ID and a recoverable outcome. Its receipt records execution facts. A process or search job can outlive the request that starts it and has its own job ID. A timeout can leave effects unknown. |

A plugin signs in with OAuth and sends MCP calls to RDH over HTTPS. The Agent keeps an outbound connection to RDH, so nothing listens on the device. A plugin's sign-in, a device's own credential, and a website session have separate purposes and are not interchangeable.

Browser sessions are an opt-in preview. A browser profile stores browser login state; it is separate from an Agent binding or an RDH account. Human takeover is an explicit handoff within a browser session.

Keep user-facing descriptions at product level. Use the exact names of tools, configuration keys and commands.
