# Contributing to dnsfik

## Release Process

This project uses semantic versioning (SemVer 2.0) for releases. Every merge to `main` with a release label will automatically create a new release and publish a Docker image.

### How to Create a Release

1. **Create a Pull Request** to the `main` branch with your changes

2. **Add a Release Label** to your PR:
   - `release:major` - For breaking changes (1.0.0 → 2.0.0)
   - `release:minor` - For new features (1.0.0 → 1.1.0)
   - `release:patch` - For bug fixes (1.0.0 → 1.0.1)

3. **Merge the PR** - The release workflow will automatically:
   - Calculate the new version based on the label
   - Create a new git tag (e.g., `v1.2.3`)
   - Generate release notes from commits
   - Create a GitHub Release
   - Build and push Docker images to GHCR with tags:
     - `ghcr.io/sigterm-015/dnsfik:v1.2.3` (full version)
     - `ghcr.io/sigterm-015/dnsfik:1.2` (major.minor)
     - `ghcr.io/sigterm-015/dnsfik:1` (major)
     - `ghcr.io/sigterm-015/dnsfik:latest`

### Skipping Releases

If you don't want to create a release (e.g., documentation changes), either:
- Don't add any `release:*` label, OR
- Add the `skip-release` label

### Example Workflow

```bash
# 1. Create a feature branch
git checkout -b feature/new-dns-provider

# 2. Make your changes and commit
git add .
git commit -m "feat: add support for AWS Route53"

# 3. Push and create PR
git push origin feature/new-dns-provider

# 4. Go to GitHub and:
#    - Create the PR
#    - Add label: release:minor (since it's a new feature)
#    - Get it reviewed
#    - Merge it

# 5. Automatic release happens! 🎉
```

### Conventional Commits (Optional but Recommended)

While not enforced, using [Conventional Commits](https://www.conventionalcommits.org/) helps generate better release notes:

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `chore:` - Maintenance tasks
- `refactor:` - Code refactoring
- `test:` - Test additions/changes
- `ci:` - CI/CD changes

Example:
```bash
git commit -m "feat: add support for AAAA records"
git commit -m "fix: correct DNS record validation"
git commit -m "docs: update README with new examples"
```

## Development Setup

See the main [README.md](README.md#development-setup) for development environment setup.

## Testing

Before submitting a PR, make sure all tests pass:

```bash
# Run tests
yarn test

# Build the project
yarn build
```

## Questions?

Open an issue or start a discussion on GitHub!

