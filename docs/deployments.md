# Deployments

## Production

Production deploys from `master` to GitHub Pages through
`.github/workflows/deploy.yml`.

- Canonical site: `https://tint.sh`
- Pages fallback: `https://corygabrielsen.github.io/tint-website/`
- Build command: `npm run build`
- Output directory: `dist`
- Custom domain marker: `public/CNAME`

## PR Previews

Use Cloudflare Pages Git integration for pull request previews while keeping
GitHub Pages as production.

Cloudflare Pages project settings:

- Project name: `tint-website`
- Repository: `corygabrielsen/tint-website`
- Production branch: `master`
- Build command: `npm run build && npm run smoke`
- Build output directory: `dist`
- Root directory: repository root
- Environment variables: none
- Node version: use the repo `.nvmrc`

Branch build controls:

- Production branch deployments: enabled for `master`
- Preview branch deployments: custom branches
- Include previews for:
  - `build/*`
  - `chore/*`
  - `ci/*`
  - `docs/*`
  - `feat/*`
  - `fix/*`
  - `perf/*`
  - `refactor/*`
  - `revert/*`
  - `style/*`
  - `test/*`

## Security

This is a public repository. Keep previews simple and secret-free.

- Do not add Cloudflare deploy tokens to GitHub Actions for PR previews.
- Do not use `pull_request_target` to build pull request code.
- Keep preview deployments public for now; they contain only static marketing
  content.
- Cloudflare Pages preview deployments are expected to send
  `X-Robots-Tag: noindex`.
- Preview URLs are only expected for pull requests that originate from this
  repository, not forks.

## Setup Checklist

Cloudflare setup has to be completed in the Cloudflare dashboard because it
requires installing/authorizing the Cloudflare GitHub integration.

1. Go to Cloudflare Workers & Pages.
2. Create a Pages project and connect it to GitHub.
3. Select `corygabrielsen/tint-website`.
4. Apply the PR preview settings above.
5. Open a test PR from a repo branch.
6. Confirm Cloudflare posts a preview URL/check on the PR.
7. Open the preview and verify the homepage demo video plays.
8. Confirm the preview response includes `x-robots-tag: noindex`:

   ```sh
   curl -I https://<preview-url>.pages.dev
   ```

9. After the first successful preview, consider making the Cloudflare Pages
   check required for PRs.

Sources:

- https://developers.cloudflare.com/pages/get-started/git-integration/
- https://developers.cloudflare.com/pages/configuration/git-integration/github-integration/
- https://developers.cloudflare.com/pages/configuration/preview-deployments/
- https://developers.cloudflare.com/pages/configuration/build-image/
