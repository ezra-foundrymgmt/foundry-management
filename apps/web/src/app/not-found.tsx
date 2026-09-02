export default function NotFound() {
  return (
    <main className="page">
      <div className="empty-state card">
        <strong>Record not found</strong>The requested CreatorOS record does not exist or is outside
        your organization.
        <br />
        <a href="/" className="button primary" style={{ marginTop: 16 }}>
          Return to Command Center
        </a>
      </div>
    </main>
  );
}
