import ReactDOM from 'react-dom/client';

import { ToastOverlay } from '@/components/ui/toast';

import './styles/globals.css';

// The transparent layer drawn above browser previews (see toast-overlay.service.ts).
ReactDOM.createRoot(document.getElementById('root')!).render(<ToastOverlay />);
