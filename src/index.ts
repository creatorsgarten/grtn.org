import { match } from "path-to-regexp";
import { html, renderHtml } from "tagged-hypertext";

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
    const pathname = new URL(request.url).pathname;

    if (pathname === "/favicon.ico") {
      return new Response(null, { status: 404 });
    }

    const amplitudePromise = trackVisit(request, env, pathname);
    const routes = await getRoutes();
    await amplitudePromise;

    if (pathname === "/") {
      return redirect("https://creatorsgarten.org/wiki/GRTN");
    }

    if (pathname === "/routes.json") {
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
  },
};

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
    {
      cf: { cacheTtl: 15 },
    }
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
  });
  if (!response.ok) {
    console.warn("Failed to track visit", response.status);
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
