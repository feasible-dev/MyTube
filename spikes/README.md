# Experimental and shared protocol code

These directories contain the original feasibility experiments. They are not the
normal installation path; start with the root README and `npm test`.

Some protocol, callback and model-task helpers are still imported by the current
connector and tests. Do not delete this directory without moving those imports
and verifying both authentication and discovery. The files named `fixtures` and
`synthetic-ratings` contain test data; collected datasets are not distributed.

Historical experiment commands in package.json may require separately collected
data. They are excluded from the product test command and are not release gates.
