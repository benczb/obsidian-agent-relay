# Scoped revisit edit candidate

Local build/test candidate only. Not installed or enabled. Existing production
entry point never passes `scopedEdit`, so all new routes return 404 by default.
No environment variables, container files, ports, credentials or sync settings
are changed. Existing OpenAPI remains unchanged until a deployment is approved.

## Scope

A trusted operator supplies one exact existing Markdown note and its one exact
referenced Base file to `createRestApp({scopedEdit: {notePath, basePath}, ...})`.
The request cannot supply or change a path. GET returns just these two files and
SHA256 hashes. POST accepts a single-line item and both expected hashes, inserting
one bullet immediately after the title. It cannot replace arbitrary content,
write a Base file, change rows, delete files or move notes. Create-only stays
create-only. This is an insertion primitive, not a general overwrite endpoint.

The configured note and Base must exist, be real files and remain inside the
vault. Symlink paths, traversal, invalid UTF-8, stale hashes and malformed titles
fail closed. An exact same first-item retry is a no-op, even using the old note
hash; the Base hash must still match. Matching item text elsewhere is not removed
or moved automatically.

## Commit and recovery

Edit and REST append to this exact note use the same cross-process lockfile.
The editor writes an exclusive mode-0600 original backup beside the note, then
fsyncs an exclusive temporary file, rechecks note/Base hashes, atomically renames,
and reads back bytes. The original text is retained byte-for-byte around the
insert, including frontmatter and line endings. Backup name is returned. Restore
is a separate operator action, not an automatic endpoint. Backups can contain
private content and should not be published or committed.

This lock coordinates cooperating REST writers. It does not lock Obsidian,
LiveSync, manual editors, other processes or the KanbanBoard writer. SHA rechecks
detect observed external changes but filesystem rename is NOT an external-writer
compare-and-swap. Before any enabled mutation an operator must pause all other
writers or supply a maintenance window. No claim of safe concurrent host editing.

## Mandatory Base-order gate before real use

Inserting Markdown at the page top does not establish the first row in a Base.
The POST result explicitly returns `baseOrderVerified: false`. Do not call it
completion of a top-of-list request.

Before deployment/use:
1. Obtain separate server-change approval and a working authenticated host route.
2. Inspect the actual Base bytes, filters, row inventory and sort definition.
3. Determine whether a new ordinary row can be created with an unambiguous first
   rank. Never guess a numeric rank or alter the Base sort to make a test pass.
4. Define/test the row change against that real configuration, preserving the
   existing list. This candidate does not implement row mutation or an ordering
   assertion because those source files were not available during development.
5. Confirm no non-cooperating writer can run during the mutation. Back up first.
6. Verify page text, actual Base row order and Obsidian pixels after the approved
   operation, plus whatever sync target is intended.

Without these checks the deployment and actual list outcome remain blocked.

## Validation

`npm run build` and `npm test`.
Six new test cases cover exact byte preservation and backup/readback, retry,
stale note/Base conflicts without mutation, CRLF/no-final-newline, bad titles,
multiline item rejection, traversal/symlink/invalid UTF-8 rejection, concurrent
idempotence, non-overwriting create, default-disabled routes, authentication,
rejection of request-selected paths, and REST append/edit concurrency.
Tests use synthetic temporary notes/Base files. They do not validate any live
Base's schema, actual ordering, live service or Obsidian rendering.
