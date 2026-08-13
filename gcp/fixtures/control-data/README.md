# Pipeline control data

This directory contains the versioned inputs used to prove the Seer v2
autonomous pipeline contract.

## Fixture types

- `golden-pipeline/` defines deterministic provider inputs and exact expected
  HAR and Revenue results. It is the calculation and orchestration oracle.
- `pilltime/` contains the original client SAFS export used for the real upload
  and end-to-end regression test.

Real client exports are immutable test inputs. Tests must copy them to a
temporary location before transforming or importing them. Synthetic provider
responses must be used for deterministic assertions; live provider responses
must not be treated as a stable numerical oracle.

CSV files in this directory are marked as binary in `.gitattributes` so Git
does not change their line endings.
