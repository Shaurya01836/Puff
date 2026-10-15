# Scripts

Seeding and resetting live in the CLI, not in separate scripts:

- `npm run puff -- seed --force`: load sample tasks, sessions and memory for the demo repo
- `npm run puff -- reset-memory`: delete tasks, sessions and memory, keeping the code graph

Planned (phase P6):

- `run-benchmark.ts`: run benchmark tasks with and without Puff, write `bench/results.json`
