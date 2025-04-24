# Parallel Steps

With this action, you can run parallel steps in a GitHub Actions workflow jobs.

Under the hood this action utilize [act](https://github.com/nektos/act)

## Known Issues
As of now the `pre` and `post` steps of given step actions will be executed at the start and end of this action itself and not at the start end end of the surrounding job as normal. 
Corresponding [act feature request](https://github.com/nektos/act/issues/2740).

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

