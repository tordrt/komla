import ReactDOM from 'react-dom/client';

import { AgentsMenuBarPopover } from '@/components/layout/status-bar/AgentsMenuBarPopover';

import './styles/globals.css';

// The macOS menu bar's agents popover (see agents-menu-bar.service.ts).
ReactDOM.createRoot(document.getElementById('root')!).render(<AgentsMenuBarPopover />);
