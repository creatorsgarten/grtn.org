import { match } from "path-to-regexp";
import { html, renderHtml } from "tagged-hypertext";
import { Toucan } from "toucan-js";

export interface Env {
  // Example binding to KV. Learn more at https://developers.cloudflare.com/workers/runtime-apis/kv/
  // MY_KV_NAMESPACE: KVNamespace;
  //
  // Example binding to Durable Object. Learn more at https://developers.cloudflare.com/workers/runtime-apis/durable-objects/
  // MY_DURABLE_OBJECT: DurableObjectNamespace;
  //
  // Example binding to R2. Learn more at https://developers.cloudflare.com/workers/runtime-apis/r2/
  // MY_BUCKET: R2Bucket;
  //
  // Example binding to a Service. Learn more at https://developers.cloudflare.com/workers/runtime-apis/service-bindings/
  // MY_SERVICE: Fetcher;

  AMPLITUDE_API_KEY: string;
  SENTRY_DSN: string;
}

interface RedirectRoute {
  from: string;
  to: string;
  definition: string;
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const sentry = new Toucan({
      dsn: env.SENTRY_DSN,
      context: ctx,
      request: request,
    });
    try {
      return await handleRequest(request, env);
    } catch (e) {
      sentry.captureException(e);
      if (new URL(request.url).hostname === "localhost") {
        // On development mode, this displays a nice error page (only in development mode).
        throw e;
      } else {
        // On production mode, when an error is thrown, the "Worker threw exception" page is displayed.
        // So we replace the error page with a nice page.
        const output = html`<!DOCTYPE html>
          <html>
            <head>
              <meta charset="utf-8" />
              <title>500 - Please try again</title>
            </head>
            <body>
              <h1>Something went wrong. Please refresh the page.</h1>
              <details>
                <summary>Technical details</summary>
                <pre>${e}</pre>
              </details>
            </body>
          </html>`;
        return new Response(renderHtml(output), {
          headers: {
            "content-type": "text/html;charset=UTF-8",
          },
          status: 500,
        });
      }
    }
  },
};

async function handleRequest(request: Request, env: Env) {
  const pathname = new URL(request.url).pathname;

  if (pathname === "/favicon.ico") {
    return new Response(null, { status: 404 });
  }

  if (pathname === "/_dev/crash") {
    throw new Error("this is a test error!");
  }

  const track = () => trackVisit(request, env, pathname);
  const routes = await getRoutes();

  if (pathname === "/") {
    await track();
    return redirect("https://creatorsgarten.org/wiki/GRTN");
  }

  if (pathname === "/routes.json") {
    await track();
    return new Response(JSON.stringify(routes, null, 2), {
      headers: {
        "content-type": "application/json;charset=UTF-8",
        "access-control-allow-origin": "*",
      },
    });
  }

  const matchingRoutes = routes.flatMap((route) => {
    const f = match("/" + route.from.replace(/\/$/, ""));
    const result = f(pathname);
    if (!result) {
      return [];
    }
    const target = route.to.replace(
      /:([a-z]+)/g,
      (a, name) => (result.params as any)[name] || a
    );
    return [{ ...route, target }];
  });

  if (matchingRoutes.length === 0) {
    const redirectTo = "https://garten.page.link/" + pathname.slice(1);
    return redirect(redirectTo);
  }

  await track();

  if (matchingRoutes.length > 1) {
    const output = html`<!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Multiple matches for ${pathname}</title>
        </head>
        <body>
          <h1>Multiple matches for ${pathname}</h1>
          <table>
            <thead>
              <tr>
                <th>URL</th>
                <th>Source</th>
              </tr>
            </thead>
            <tbody>
              ${matchingRoutes.map(
                (route) => html`<tr>
                  <td><a href="${route.target}">${route.target}</a></td>
                  <td>
                    <a href="${route.definition}"
                      >${new URL(route.definition).pathname}</a
                    >
                  </td>
                </tr>`
              )}
            </tbody>
          </table>
        </body>
      </html>`;
    return new Response(renderHtml(output), {
      headers: {
        "content-type": "text/html;charset=UTF-8",
      },
    });
  }
  return redirect(matchingRoutes[0].target);
}

async function getRoutes() {
  const [shortcuts, redirects] = await Promise.all([
    searchWiki({ grtn: true }),
    searchWiki({ grtnRedirects: true }),
  ]);
  const pages = [
    ...shortcuts.result.data.results,
    ...redirects.result.data.results,
  ];

  const routes: RedirectRoute[] = [];
  for (const page of pages) {
    const pageRef = page.pageRef;

    const shortcut = page.frontMatter?.grtn;
    if (typeof shortcut === "string") {
      routes.push({
        from: shortcut,
        to: wikiUrl(pageRef),
        definition: wikiUrl(pageRef),
      });
    }

    const redirects = page.frontMatter?.grtnRedirects;
    if (redirects && typeof redirects === "object") {
      for (const [from, to] of Object.entries(redirects)) {
        if (typeof from === "string" && typeof to === "string") {
          routes.push({ from, to, definition: wikiUrl(pageRef) });
        }
      }
    }
  }
  return routes;
}

async function searchWiki(query: any) {
  const response = await fetch(
    "https://wiki.creatorsgarten.org/api/contentsgarten/search?" +
      new URLSearchParams({
        input: JSON.stringify({ match: query }),
      }),
    { cf: { cacheTtl: 15 } }
  );
  if (!response.ok) {
    throw new Error(`HTTP error! status: ${response.status}`);
  }
  return response.json() as any;
}

function wikiUrl(pageRef: string) {
  if (pageRef.startsWith("Events/")) {
    return `https://creatorsgarten.org/event/${pageRef.slice(7)}`;
  }
  return `https://creatorsgarten.org/wiki/${pageRef}`;
}

async function trackVisit(request: Request, env: Env, pathname: string) {
  const amplitudeApiKey = env.AMPLITUDE_API_KEY;
  if (!amplitudeApiKey) {
    return;
  }
  try {
    // Allow 1000ms for the request to complete
    const abortController = new AbortController();
    const timeout = setTimeout(() => {
      abortController.abort();
      console.warn("Timed out tracking visit");
    }, 1000);
    const response = await fetch("https://api2.amplitude.com/2/httpapi", {
      method: "POST",
      body: JSON.stringify({
        api_key: amplitudeApiKey,
        events: [
          {
            user_id: "anonymous_user",
            event_type: "visit",
            event_properties: {
              pathname,
            },
            ip: request.headers.get("cf-connecting-ip"),
          },
        ],
      }),
      signal: abortController.signal,
    });
    if (!response.ok) {
      console.warn("Failed to track visit", response.status);
    }
    clearTimeout(timeout);
  } catch (error) {
    console.warn("Failed to track visit", error);
  }
}

function redirect(target: string) {
  const output = html`<!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta http-equiv="refresh" content="0; url=${target}" />
        <title>Redirecting to ${target}</title>
      </head>
      <body>
        Redirecting to <a href="${target}">${target}</a>.
      </body>
    </html>`;
  return new Response(renderHtml(output), {
    status: 302,
    headers: {
      Location: target,
    },
  });
}
