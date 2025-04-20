# Parallel Steps

With this action, you can run parallel steps in a GitHub Actions workflow jobs.

## Usage

```yaml
jobs:
  run:
    runs-on: ubuntu-latest
    steps:
      - uses: qoomon/actions--parallel-steps@v1
        with:
          steps: |
            - run: echo Step0
            - run: echo Step1
            - uses: actions/github-script@v7
              with:
                script: console.log('Step2')
```
