declare module "*.css";
declare module "*.svg" { const path: string; export default path; }
declare module "*.png" { const path: string; export default path; }
declare module "*.webmanifest" { const path: string; export default path; }
declare module "*/sw.js" { const path: string; export default path; }
declare module "*.html" { const bundle: import("bun").HTMLBundle; export default bundle; }
