import { Callout } from '@/components/ui/callout';

interface FormErrorProps {
  message: string | null;
}

export function FormError({ message }: FormErrorProps) {
  if (!message) return null;
  return (
    <Callout tone="error" role="alert">
      {message}
    </Callout>
  );
}
