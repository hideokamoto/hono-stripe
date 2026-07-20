import type { Child } from 'hono/jsx'

export const Layout = (props: { title: string; children: Child }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{props.title}</title>
      <style>{`
        body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 3rem auto; padding: 0 1rem; }
        h1 { font-size: 1.4rem; }
        a { color: #635bff; }
      `}</style>
    </head>
    <body>
      <main>{props.children}</main>
    </body>
  </html>
)
