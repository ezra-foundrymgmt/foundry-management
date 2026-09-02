"use client";
export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="page">
      <div className="empty-state card">
        <strong>CreatorOS could not load this view</strong>Your data was not changed. Try loading
        the view again.
        <br />
        <button className="button primary" type="button" onClick={reset} style={{ marginTop: 16 }}>
          Try again
        </button>
      </div>
    </main>
  );
}
