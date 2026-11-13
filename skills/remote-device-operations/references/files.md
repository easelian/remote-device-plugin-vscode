# File operations

Use `list_directory` with `next_offset` for browsing. Check advertised tools
and device capabilities before using extended file operations. Choose reads
by purpose:

| Need | Tool and result |
| --- | --- |
| Metadata | `file_info` returns an opaque `fingerprint`, not a content hash |
| Browse or tail bytes | `read_file_chunk` returns a bounded range, without whole-file SHA-256 |
| Edit baseline | `read_file` returns current text and the whole-file `sha256`, even when the text is paginated |

Pass the returned `read_file.sha256` unchanged as `expected_sha256`;
do not hash the displayed preview.
`read_multiple_files` batches previews; it does not supply whole-file hashes.
Its limits differ from single-file reads: at most 16 paths, `length` at most
16384 bytes per file, and `total_limit` at most 262144 bytes for the batch.
Check individual results for errors and truncation; a partial batch does not
mean every requested file was read. Use the current schema if limits differ.

File-read offsets and lengths count source bytes. For `read_file` and
`read_file_chunk`, omit `length` for 32768 bytes or choose 1..65536 per call.
The 1 MiB file-size limit is separate from this range limit: `read_file`,
`edit_file`, and `write_file` reject a file or content over 1 MiB
(`file_limit_bytes` in `device_info`). `read_file_chunk` browses files up to
64 MiB but supplies no edit baseline, so the file tools cannot change a larger
file. Report that limit instead of retrying; a shell command may change such a
file only with shell permission and authorization for that command.
For a full read, start at offset 0 and follow the returned `next_offset` while
`truncated` is true and more content is needed. Stop when complete or the
requested scope is satisfied; a numeric final `next_offset` alone is not a
reason to keep reading. Report incomplete reads.

For the end of a file, such as the tail of a log, call `read_file_chunk` with
`from_end: true`. It returns the last `length` bytes; a nonzero `offset` then
skips that many bytes back from the end. The returned `offset` is the start
byte of the range. When it is greater than 0, earlier content exists, even if
`truncated` is false.

For `read_file_chunk`, use the advertised `encoding`: `text` for previews,
`base64` for exact bytes, or `both`. Invalid or split UTF-8 can produce replacement
characters; inspect `utf8_valid` and use `content_base64` when exact bytes matter.
A whole-file hash does not mean the displayed text is complete: read the
relevant ranges before choosing an edit or constructing replacement content.
Do not request secret files for an unrelated task.

For an existing file, read its current text and `sha256`, reserve an operation
ID when [recovery](recovery.md) calls for one, then call
`edit_file` with `path`, `old_text`, `new_text`, and that `expected_sha256`, or
`write_file` with the replacement content and hash. Both need the selected
`device_id` and named `root`. `edit_file` requires one exact match. Reread and
reconcile stale hashes or ambiguous matches; never use an empty hash to overwrite.
A successful `edit_file` or `write_file` returns the file's new `sha256`: use
that value as `expected_sha256` for the next change to the same file.
Read back the affected content before reporting success; a receipt is not content
verification. For a new file, an empty `write_file.expected_sha256` means create-only.

`make_directory` creates missing parent directories; existing directories succeed.
`move_file` uses `source` and `destination`, both relative to the same named root.
It moves regular files within one filesystem; the destination must not exist.
Check both paths before the move. There is no dedicated delete-file tool;
a shell deletion needs shell permission and authorization for its effects.

`search_files` takes the search text in `query`. With `content: false`, it matches
filename substrings; with `content: true`, it searches UTF-8 file contents.
Search is literal: `*.txt` searches those characters, not a glob or regex.
For larger searches, use supported `start_search`, `get_search_results`,
`list_searches`, and `stop_search`. `start_search.pattern` only accepts `literal`;
the search text still belongs in `query`. Follow offsets and report truncation.
Stop a search only when the task calls for cancellation.
