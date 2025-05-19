# Parallel Steps &nbsp; [![Actions](https://img.shields.io/badge/qoomon-GitHub%20Actions-blue)](https://github.com/qoomon/actions)

With this action, you can run parallel steps in a GitHub Actions workflow jobs.

Under the hood this action utilize [act](https://github.com/nektos/act).

## Known Issues
- act doesn't implement support for `GITHUB_STEP_SUMMARY` (https://github.com/nektos/act/issues/2759)
- Only 4 parallel steps supported by act (https://github.com/nektos/act/issues/2756)

## Usage

```yaml
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: qoomon/actions--parallel-steps@v1
        id: parallel-steps
        with:
          steps: |
            - run: echo Step0
            - run: echo Step1
            - uses: actions/github-script@v7
              id: greetings
              with:
                script: |
                  const recipient = 'world'
                  console.log(`Hello ${recipient}!`)
                  core.setOutput('recipient', recipient)
            
      # access parallel steps outputs            
      - run: echo Hello $RECIPIENT
        env:
          RECIPIENT: ${{ steps.parallel-steps.outputs.greetings-recipient }}
```

## Workflow Run Examples
https://github.com/qoomon/actions--parallel-steps/actions/workflows/example.yaml

## Development
- run locally
  ```bash
  RUNNER_DEBUG=1 gh act --workflows .github/workflows/example.yaml --platform ubuntu-latest=-self-hosted -s GITHUB_TOKEN="$(gh auth token)" --local-repository qoomon/actions--parallel-steps@main=$PWD
  ```
