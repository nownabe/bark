// SPA shell — Design Doc §6 (Extension SPA Page).
// Scaffold: reads the PR reference from the URL and shows it. The actual review
// surface (renderer, comment/suggestion layer, editor, review tray) is built in
// later slices (難所#1 rendering→source map, #2/#3 GitHub round-trip).
export function App() {
  const params = new URLSearchParams(window.location.search);
  const owner = params.get('owner');
  const repo = params.get('repo');
  const pr = params.get('pr');
  const hasRef = owner && repo && pr;

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        maxWidth: 760,
        margin: '40px auto',
        padding: '0 16px',
        lineHeight: 1.6,
      }}
    >
      <h1 style={{ fontSize: 22 }}>DocReview</h1>
      {hasRef ? (
        <p>
          <strong>
            {owner}/{repo}
          </strong>{' '}
          #{pr} <span style={{ color: '#57606a' }}>(scaffold)</span>
        </p>
      ) : (
        <p style={{ color: '#cf222e' }}>
          No PR reference. Open this page from the "Open in DocReview" button on a
          GitHub pull request.
        </p>
      )}
      <p style={{ color: '#57606a' }}>
        Rendering, range selection, comments and GitHub round-trip are not yet
        implemented — this is the M0 scaffold.
      </p>
    </main>
  );
}
