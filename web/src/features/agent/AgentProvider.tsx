import { createContext, use, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AgentController } from './controller';
import { Softphone, type UAFactory } from './softphone/softphone';
import { createJsSipUA } from './softphone/jssip';

type Agent = { phone: Softphone; controller: AgentController };
const AgentContext = createContext<Agent | null>(null);

/** One phone line + one call controller for the agent screen's lifetime. */
export function AgentProvider({ children, createUA = createJsSipUA }: { children: ReactNode; createUA?: UAFactory }) {
  const queryClient = useQueryClient();
  const [agent] = useState<Agent>(() => {
    const audio = typeof Audio === 'undefined' ? null : new Audio();
    if (audio) audio.autoplay = true;
    const phone = new Softphone(createUA, audio);
    return { phone, controller: new AgentController({ phone, queryClient }) };
  });
  useEffect(
    () => () => {
      agent.controller.dispose();
      agent.phone.disconnect();
    },
    [agent],
  );
  return <AgentContext value={agent}>{children}</AgentContext>;
}

function useAgent() {
  const agent = use(AgentContext);
  if (!agent) throw new Error('useAgent outside <AgentProvider>');
  return agent;
}

export function usePhone() {
  const { phone } = useAgent();
  return { phone, line: useSyncExternalStore(phone.subscribe, phone.getSnapshot) };
}

export function useController() {
  const { controller } = useAgent();
  return { controller, state: useSyncExternalStore(controller.subscribe, controller.getSnapshot) };
}
