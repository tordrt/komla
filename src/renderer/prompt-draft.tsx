import ReactDOM from 'react-dom/client';

import { PoppedOutPromptDraft } from '@/components/prompt-draft/PoppedOutPromptDraft';

import './styles/globals.css';

// The prompt draft, popped out into a window of its own (see prompt-draft-window.service.ts).
ReactDOM.createRoot(document.getElementById('root')!).render(<PoppedOutPromptDraft />);
