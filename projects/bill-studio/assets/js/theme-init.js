// Apply the saved theme before first paint (classic script, runs before the app).
// Light by default; 'system' follows the OS, 'dark' forces dark.
    try { const t = localStorage.getItem('bs-theme') || 'light'; if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch (e) { document.documentElement.dataset.theme = 'light'; }
