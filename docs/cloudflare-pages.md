# Host the marketing site on Cloudflare Pages

The marketing site (`packages/marketing`: easytestdata.com, the docs pages, the blog and the
playground) is plain static files. It is hosted on Cloudflare Pages, apart from the app, which
runs on its own host ([deploy-cloudpanel.md](deploy-cloudpanel.md)). The app's server does not
serve the marketing site.

## Create the Pages project

In the Cloudflare dashboard: **Workers & Pages > Create > Pages > Connect to Git**, pick the
`easytestdata/easytestdata` repository and the `main` branch, then set:

| Setting                | Value                                                                           |
| ---------------------- | ------------------------------------------------------------------------------- |
| Build command          | `pnpm install --frozen-lockfile && pnpm --filter @easytestdata/marketing build` |
| Build output directory | `packages/marketing/dist`                                                       |
| Root directory         | (leave empty: the repository root)                                              |

Environment variables (Production, and Preview if you use preview deployments):

| Variable       | Value                                                           |
| -------------- | --------------------------------------------------------------- |
| `APP_URL`      | The Cloud app's URL, for example `https://app.easytestdata.com` |
| `NODE_VERSION` | `24` (the project's build version; 22.13 or later also works)   |

`APP_URL` is read at build time: every "Sign in" and "Start free on Cloud" link on the site
points there. Without it the build uses `https://app.easytestdata.com`. Changing it needs a new
deployment (**Deployments > Retry deployment**).

## Custom domain

Under the project's **Custom domains**, add the site's domain (for example `easytestdata.com`,
and `www.easytestdata.com` if you want it). With the domain's DNS on Cloudflare, the records and
certificate are set up for you. Set the app's `MARKETING_URL` to the same address, so the app's
Terms and Privacy links point here.

## The playground

The playground page runs the generation engine (`@easytestdata/core`, bundled into the site at
build time) entirely in the visitor's browser. It needs no server and no account, and nothing a
visitor generates there is sent anywhere.
