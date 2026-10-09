// The real SIP stack. Kept apart from softphone.ts so tests can swap in a fake.
import JsSIP from 'jssip';
import type { UAFactory, UALike } from './softphone';

export const createJsSipUA: UAFactory = ({ extension, password, wsUrl, sipDomain }) =>
  new JsSIP.UA({
    sockets: [new JsSIP.WebSocketInterface(wsUrl)],
    uri: `sip:${extension}@${sipDomain}`,
    password,
    register: true,
  }) as unknown as UALike;
