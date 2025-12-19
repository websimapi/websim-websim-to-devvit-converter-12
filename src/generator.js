import JSZip from 'jszip';
import { 
    cleanName, 
    AssetAnalyzer 
} from './processors.js';

import { WebSimDetector } from './websim-detector.js';

import {
    generatePackageJson,
    generateDevvitYaml,
    generateViteConfig,
    tsConfig,
    getMainTsx,
    simpleLoggerJs,
    websimSocketPolyfill,
    websimStubsJs,
    websimPackageJs,
    jsxDevProxy,
    validateScript,
    setupScript,
    generateReadme,
    websimToDevvitPolyfill,
    getDevvitBridgeServerCode
} from './templates.js';

export async function generateDevvitZip(projectMeta, assets, includeReadme = true) {
    const zip = new JSZip();
    
    const safeId = projectMeta.project.id ? projectMeta.project.id.slice(0, 6) : '000000';
    const rawSlug = projectMeta.project.slug || "websim-game";
    const projectSlug = cleanName(`${rawSlug}-${safeId}`);
    const projectTitle = projectMeta.project.title || "WebSim Game";

    // Initialize Analyzers
    const assetAnalyzer = new AssetAnalyzer();
    const websimDetector = new WebSimDetector();
    const clientFiles = {};

    console.log('[Generator] Starting WebSim → Devvit conversion...');

    // 1. Process Assets for Client Folder AND Detect WebSim APIs
    for (const [path, content] of Object.entries(assets)) {
        if (path.includes('..')) continue;

        if (/\.(js|mjs|ts|jsx|tsx)$/i.test(path)) {
            // Process imports first
            const processedJS = assetAnalyzer.processJS(content, path);
            
            // Then detect and replace WebSim APIs
            const { code: finalCode } = websimDetector.processScript(processedJS, path);
            
            clientFiles[path] = finalCode;
        } else if (path.endsWith('.html')) {
            // Process HTML
            const { html, extractedScripts } = assetAnalyzer.processHTML(content, path.split('/').pop());
            
            // Process extracted scripts for WebSim APIs
            extractedScripts.forEach(script => {
                const { code } = websimDetector.processScript(script.content, script.filename);
                script.content = code;
            });
            
            // Inject Devvit bridge if needed
            const finalHtml = websimDetector.processHTML(html, path);
            clientFiles[path] = finalHtml;
            
            // Add extracted inline scripts to client files
            extractedScripts.forEach(script => {
                const parts = path.split('/');
                parts.pop();
                const dir = parts.join('/');
                const fullPath = dir ? `${dir}/${script.filename}` : script.filename;
                clientFiles[fullPath] = script.content;
            });
        } else if (path.endsWith('.css')) {
            clientFiles[path] = assetAnalyzer.processCSS(content, path);
        } else {
            // Static assets (images, etc)
            clientFiles[path] = content;
        }
    }

    // Get detection summary
    const apiSummary = websimDetector.getSummary();
    console.log('[Generator] WebSim API Detection Summary:', apiSummary);

    // Identify Index for Devvit Main.tsx
    let indexPath = 'index.html'; 
    for (const p of Object.keys(clientFiles)) {
        if (p.endsWith('index.html')) {
            indexPath = p;
            break; 
        }
    }

    // 2. Generate Config Files
    const hasRemotion = !!assetAnalyzer.dependencies['remotion'];
    const hasReact = hasRemotion || !!assetAnalyzer.dependencies['react'];

    const extraDevDeps = {};
    if (hasReact) {
        extraDevDeps['@vitejs/plugin-react'] = '^4.2.0';
        extraDevDeps['@babel/core'] = '^7.23.0';
        extraDevDeps['@babel/preset-react'] = '^7.23.0';
    }

    // Add Devvit dependencies if WebSim APIs detected (included in default kit mostly)
    
    zip.file("package.json", generatePackageJson(projectSlug, assetAnalyzer.dependencies, extraDevDeps));
    zip.file("devvit.yaml", generateDevvitYaml(projectSlug));
    zip.file("vite.config.js", generateViteConfig({ hasReact, hasRemotion }));
    zip.file("tsconfig.json", tsConfig);
    zip.file(".gitignore", "node_modules\n.devvit\nwebroot/assets");

    // Generate README with migration notes
    if (includeReadme) {
        const baseReadme = generateReadme(projectTitle, `https://websim.ai/p/${projectMeta.project.id}`);
        const migrationNotes = websimDetector.generateMigrationNotes();
        const fullReadme = baseReadme + '\n\n' + migrationNotes;
        zip.file("README.md", fullReadme);
    }

    zip.file("scripts/setup.js", setupScript);
    zip.file("scripts/validate.js", validateScript);

    // 3. Client Folder (Source)
    const clientFolder = zip.folder("client");
    const publicFolder = clientFolder.folder("public");

    for (const [path, content] of Object.entries(clientFiles)) {
        if (/\.(html|js|mjs|ts|jsx|tsx|css|scss)$/i.test(path)) {
            clientFolder.file(path, content);
        } else {
            publicFolder.file(path, content);
        }
    }

    // Add Polyfills to Client
    clientFolder.file("logger.js", simpleLoggerJs);
    // clientFolder.file("websim_socket.js", websimSocketPolyfill); // Replaced by devvit-bridge-client if detected, but keep for compatibility
    clientFolder.file("websim_stubs.js", websimStubsJs);
    clientFolder.file("websim_package.js", websimPackageJs);
    clientFolder.file("jsx-dev-proxy.js", jsxDevProxy);

    // Add Devvit Bridge Client-Side Polyfill if needed
    if (apiSummary.needsDevvitBridge) {
        console.log('[Generator] Injecting Devvit bridge polyfill...');
        clientFolder.file("devvit-bridge-client.js", websimToDevvitPolyfill);
    } else {
        // Fallback for simple projects
        clientFolder.file("websim_socket.js", websimSocketPolyfill);
    }

    // Add Remotion Bridge if needed
    if (hasRemotion) {
        clientFolder.file("remotion_bridge.js", `
export * from 'remotion';
export { Player } from '@remotion/player';
        `.trim());
    }

    // 4. Source Code (Devvit Main.tsx + Bridge)
    const srcFolder = zip.folder("src");
    srcFolder.file("main.tsx", getMainTsx(projectTitle, indexPath));
    
    // Add server-side Devvit Bridge if WebSim APIs detected
    if (apiSummary.needsDevvitBridge) {
        console.log('[Generator] Adding server-side Devvit bridge...');
        srcFolder.file("devvit-bridge.ts", getDevvitBridgeServerCode());
    }

    console.log('[Generator] Conversion complete!');
    
    const blob = await zip.generateAsync({ type: "blob" });
    return { blob, filename: `${projectSlug}-devvit.zip` };
}

