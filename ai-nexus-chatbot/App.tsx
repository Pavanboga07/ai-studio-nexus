import React, { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  Database,
  FileCode2,
  MessageSquare,
  Network,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Plus,
  RefreshCw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-react';
import {
  AuditEventRecord,
  ExecutionMode,
  GroupSession,
  InvocationRecord,
  MemoryCategory,
  MemoryEntry,
  MemoryShareGrant,
  PermissionMode,
  PermissionRule,
  PublicAIIdentity,
} from './protocol';
import {
  ChatAttachment,
  ChatMessage,
  ConversationThread,
} from './chatbot/engine';
import { NetworkPermissionsView } from './components/NetworkPermissionsView';
import { MemoryVaultView } from './components/MemoryVaultView';
import { ArchitectureBlueprintView } from './components/ArchitectureBlueprintView';
import { SettingsModal } from './components/SettingsModal';

type WorkspaceView = 'chat' | 'network' | 'memory' | 'architecture';

const SLASH_COMMANDS = [
  {
    cmd: '/ask @bob What is your availability tomorrow for a meeting?',
    desc: 'Invoke Bob AI via Gateway (Calendar Free/Busy minimization)',
  },
  {
    cmd: '/ask @bob Coordinate and confirm a meeting slot tomorrow afternoon',
    desc: 'Invoke Bob AI with Autonomous Multi-Turn Follow-Up negotiation',
  },
  {
    cmd: '/ask @charlie What are the top security audit findings for Phase 8?',
    desc: 'Invoke Charlie AI for authorized work project summary',
  },
  {
    cmd: '/ask @bob What is in your private notes?',
    desc: 'Test deterministic Policy Engine DENY on unauthorized private notes',
  },
  {
    cmd: '/ask-all Review this business proposal and identify the biggest risks.',
    desc: 'Broadcast to all Personal AIs in the active Group Session',
  },
  {
    cmd: '/share-memory @bob Alice prefers 30-minute afternoon syncs after 2 PM PST.',
    desc: 'Explicitly grant Bob AI read-only access to a memory entry',
  },
  {
    cmd: '/group create Cross-AI Architecture Council',
    desc: 'Create a new multi-AI group session with @alice, @bob, and @charlie',
  },
];

export function App() {
  const [activeView, setActiveView] = useState<WorkspaceView>('chat');
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(true);
  const [darkMode, setDarkMode] = useState<boolean>(true);
  const [settingsOpen, setSettingsOpen] = useState<boolean>(false);

  // Core Platform State loaded from `/api/chatbot/bootstrap`
  const [activeAiId, setActiveAiId] = useState<string>('ai_alice');
  const [identities, setIdentities] = useState<PublicAIIdentity[]>([]);
  const [conversations, setConversations] = useState<ConversationThread[]>([]);
  const [activeConversationId, setActiveConversationId] = useState<string>('conv_alice_main');
  const [groups, setGroups] = useState<GroupSession[]>([]);
  const [permissionsByOwner, setPermissionsByOwner] = useState<Record<string, PermissionRule[]>>({});
  const [memoriesByOwner, setMemoriesByOwner] = useState<Record<string, MemoryEntry[]>>({});
  const [memoryGrants, setMemoryGrants] = useState<MemoryShareGrant[]>([]);
  const [invocations, setInvocations] = useState<InvocationRecord[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<InvocationRecord[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEventRecord[]>([]);
  const [gatewayStatus, setGatewayStatus] = useState<{
    connected: boolean;
    httpUrl: string;
    wsUrl: string;
    error?: string | null;
  }>({
    connected: true,
    httpUrl: import.meta.env.VITE_GATEWAY_HTTP_URL || 'http://localhost:4000',
    wsUrl: import.meta.env.VITE_GATEWAY_WS_URL || 'ws://localhost:4000/ws/node',
    error: null,
  });

  // Chat & Composer State
  const [sidebarSearch, setSidebarSearch] = useState<string>('');
  const [composerText, setComposerText] = useState<string>('');
  const [autonomousFollowUp, setAutonomousFollowUp] = useState<boolean>(true);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [isSending, setIsSending] = useState<boolean>(false);
  const [statusActivityText, setStatusActivityText] = useState<string | null>(null);
  const [expandedEnvelopeMsgId, setExpandedEnvelopeMsgId] = useState<string | null>('msg_seed_2');
  const [copiedMsgId, setCopiedMsgId] = useState<string | null>(null);
  const [showCommandHelper, setShowCommandHelper] = useState<boolean>(false);

  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // Sync Dark Mode class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (darkMode) {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [darkMode]);

  const fetchBootstrap = async (aiIdToLoad: string = activeAiId) => {
    try {
      const res = await fetch(`/api/chatbot/bootstrap?aiId=${encodeURIComponent(aiIdToLoad)}`);
      if (!res.ok) return;
      const data = await res.json();
      setIdentities(data.identities ?? []);
      setConversations(data.conversations ?? []);
      setGroups(data.groups ?? []);
      setPermissionsByOwner(data.permissions ?? {});
      setMemoriesByOwner(data.memories ?? {});
      setMemoryGrants(data.memoryGrants ?? []);
      setInvocations(data.invocations ?? []);
      setPendingApprovals(data.pendingApprovals ?? []);
      setAuditEvents(data.auditEvents ?? []);
      if (data.gatewayStatus) {
        setGatewayStatus({
          connected: Boolean(data.gatewayStatus.connected),
          httpUrl:
            data.gatewayStatus.httpUrl ||
            import.meta.env.VITE_GATEWAY_HTTP_URL ||
            'http://localhost:4000',
          wsUrl:
            data.gatewayStatus.wsUrl ||
            import.meta.env.VITE_GATEWAY_WS_URL ||
            'ws://localhost:4000/ws/node',
          error: data.gatewayStatus.error ?? null,
        });
      }
    } catch {
      // Keep current state on transient network error
    }
  };

  useEffect(() => {
    fetchBootstrap(activeAiId);
  }, [activeAiId]);

  const activeIdentity =
    identities.find((i) => i.aiId === activeAiId) ??
    identities[0] ?? {
      aiId: 'ai_alice',
      handle: '@alice',
      displayName: 'Alice AI',
      ownerId: 'owner_alice',
      ownerDisplayName: 'Alice Vance',
      nodeId: 'node_alice_local_mac01',
      deviceId: 'dev_alice_mbp16',
      publicKeyPem: '',
      keyFingerprint: 'ed25519:a11ce98f4d20b7e1c9034f82',
      registrationState: 'REGISTERED',
      verificationState: 'VERIFIED',
      executionMode: ExecutionMode.LOCAL,
      online: true,
      killSwitchActive: false,
      supportedProtocolVersions: ['1.0'],
      configuredProvider: 'gemini',
      configuredModel: 'gemini-3.8-flash',
      createdAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    };

  const activeConversation =
    conversations.find((c) => c.id === activeConversationId) ?? conversations[0];

  const filteredConversations = conversations.filter((c) =>
    sidebarSearch.trim() === ''
      ? true
      : c.title.toLowerCase().includes(sidebarSearch.toLowerCase())
  );

  // Handlers
  const handleSendMessage = async (overrideContent?: string) => {
    const textToSend = (overrideContent ?? composerText).trim();
    if (!textToSend || isSending) return;

    if (!overrideContent) {
      setComposerText('');
    }
    setShowCommandHelper(false);
    setIsSending(true);

    // Show natural AI-to-AI communication step summary
    if (textToSend.startsWith('/ask ') || /ask\s+(bob|charlie|alice)/i.test(textToSend)) {
      setStatusActivityText(
        'Signing Ed25519 envelope → Routing via AI Nexus Gateway → Checking recipient OwnerPolicyEngine…'
      );
    } else if (textToSend.startsWith('/ask-all') || activeConversation?.isGroup) {
      setStatusActivityText(
        'Coordinating Group Session → Dispatching to @alice, @bob, and @charlie Personal AIs…'
      );
    } else {
      setStatusActivityText(`Synthesizing response via ${activeIdentity.displayName} (${activeIdentity.configuredModel})…`);
    }

    try {
      const res = await fetch('/api/chatbot/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: activeConversation?.id ?? 'conv_alice_main',
          senderAiId: activeAiId,
          content: textToSend,
          enableAutonomousFollowUp: autonomousFollowUp,
          attachments,
        }),
      });
      setAttachments([]);

      if (res.ok) {
        const data = await res.json();
        await fetchBootstrap(activeAiId);
        if (data.conversation?.id) {
          setActiveConversationId(data.conversation.id);
        }
      }
    } finally {
      setIsSending(false);
      setStatusActivityText(null);
      setTimeout(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 60);
    }
  };

  const handleNewConversation = async () => {
    const res = await fetch('/api/chatbot/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ownerAiId: activeAiId,
        title: `Session with ${activeIdentity.displayName}`,
      }),
    });
    if (res.ok) {
      const data = await res.json();
      await fetchBootstrap(activeAiId);
      if (data.conversation?.id) {
        setActiveConversationId(data.conversation.id);
        setActiveView('chat');
      }
    }
  };

  const handleTogglePin = async (convId: string) => {
    await fetch(`/api/chatbot/conversations/${encodeURIComponent(convId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ togglePin: true }),
    });
    await fetchBootstrap(activeAiId);
  };

  const handleDeleteConversation = async (convId: string) => {
    await fetch(`/api/chatbot/conversations/${encodeURIComponent(convId)}`, {
      method: 'DELETE',
    });
    await fetchBootstrap(activeAiId);
  };

  const handleToggleNodeOnline = async (
    aiId: string,
    online: boolean,
    executionMode?: ExecutionMode
  ) => {
    await fetch(`/api/chatbot/nodes/${encodeURIComponent(aiId)}/presence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ online, executionMode }),
    });
    await fetchBootstrap(activeAiId);
  };

  const handleToggleKillSwitch = async (aiId: string, active: boolean) => {
    await fetch(`/api/chatbot/nodes/${encodeURIComponent(aiId)}/kill-switch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active }),
    });
    await fetchBootstrap(activeAiId);
  };

  const handleRotateKey = async (aiId: string) => {
    await fetch(`/api/chatbot/nodes/${encodeURIComponent(aiId)}/rotate-key`, {
      method: 'POST',
    });
    await fetchBootstrap(activeAiId);
  };

  const handleVerifyPairing = async (aiId: string, nodeId: string): Promise<string> => {
    const verRes = await fetch(
      `/api/chatbot/nodes/${encodeURIComponent(aiId)}/verify-pairing`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nodeId }),
      }
    );
    if (!verRes.ok) return 'Failed to reach AI Nexus Gateway for pairing challenge.';
    const verData = await verRes.json();
    await fetchBootstrap(activeAiId);
    return verData.verified
      ? `Verified Proof-of-Possession (${verData.challengeId}) via Ed25519 signature over Gateway (${gatewayStatus.httpUrl}).`
      : `Verification failed: ${verData.reason || 'Gateway unreachable'}`;
  };

  const handleUpdatePermissionMode = async (
    ownerAiId: string,
    ruleId: string,
    mode: PermissionMode
  ) => {
    await fetch(
      `/api/chatbot/permissions/${encodeURIComponent(ownerAiId)}/${encodeURIComponent(ruleId)}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      }
    );
    await fetchBootstrap(activeAiId);
  };

  const handleResolveApproval = async (requestId: string, approve: boolean) => {
    await fetch(`/api/chatbot/approvals/${encodeURIComponent(requestId)}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approve }),
    });
    await fetchBootstrap(activeAiId);
  };

  const handleAddMemory = async (params: {
    ownerAiId: string;
    category: MemoryCategory;
    title: string;
    content: string;
    tags: string[];
  }) => {
    await fetch('/api/chatbot/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    await fetchBootstrap(activeAiId);
  };

  const handleShareMemory = async (params: {
    memoryId: string;
    ownerAiId: string;
    recipientAiId: string;
    ttlHours: number;
  }) => {
    await fetch('/api/chatbot/memories/share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    await fetchBootstrap(activeAiId);
  };

  const handleRevokeGrant = async (grantId: string, ownerAiId: string): Promise<string> => {
    const res = await fetch(
      `/api/chatbot/memories/grants/${encodeURIComponent(grantId)}/revoke`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerAiId }),
      }
    );
    const data = await res.json();
    await fetchBootstrap(activeAiId);
    return data.limitationDisclosure ?? 'Access grant revoked.';
  };

  const handleUpdateModel = async (aiId: string, provider: string, model: string) => {
    await fetch(`/api/chatbot/identities/${encodeURIComponent(aiId)}/model`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, model }),
    });
    await fetchBootstrap(activeAiId);
  };

  const handleCopyMessage = (msg: ChatMessage) => {
    navigator.clipboard?.writeText(msg.content);
    setCopiedMsgId(msg.id);
    setTimeout(() => setCopiedMsgId(null), 1500);
  };

  const handleAddDemoAttachment = () => {
    setAttachments((prev) => [
      ...prev,
      {
        id: `att_${Date.now()}`,
        name: 'Q4_AI_Nexus_Proposal_v1.pdf',
        type: 'file',
        sizeLabel: '420 KB',
      },
    ]);
  };

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100">
      {/* ====================================================================
          TOP NAVIGATION BAR (Strict 3-Zone Contract: Brand — 4 Nav Links — 1 CTA)
         ==================================================================== */}
      <header className="flex items-center justify-between gap-8 px-6 py-3.5 border-b border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shrink-0">
        {/* Zone 1: Single text element wordmark */}
        <a
          href="#chat"
          onClick={(e) => {
            e.preventDefault();
            setActiveView('chat');
          }}
          className="text-lg font-bold tracking-tight text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0 font-display"
        >
          AI Nexus
        </a>

        {/* Zone 2: 4 concise single-line text navigation links */}
        <nav
          aria-label="Primary Workspace Navigation"
          className="flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-400 overflow-x-auto"
        >
          <a
            href="#chat"
            onClick={(e) => {
              e.preventDefault();
              setActiveView('chat');
            }}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeView === 'chat'
                ? 'text-indigo-600 dark:text-indigo-400 underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Chat Workspace
          </a>
          <a
            href="#network"
            onClick={(e) => {
              e.preventDefault();
              setActiveView('network');
            }}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeView === 'network'
                ? 'text-indigo-600 dark:text-indigo-400 underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Network & Permissions
            {pendingApprovals.length > 0 ? ` (${pendingApprovals.length})` : ''}
          </a>
          <a
            href="#memory"
            onClick={(e) => {
              e.preventDefault();
              setActiveView('memory');
            }}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeView === 'memory'
                ? 'text-indigo-600 dark:text-indigo-400 underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Memory Vault
          </a>
          <a
            href="#architecture"
            onClick={(e) => {
              e.preventDefault();
              setActiveView('architecture');
            }}
            className={`hover:text-slate-900 dark:hover:text-slate-100 transition-colors whitespace-nowrap shrink-0 py-1 ${
              activeView === 'architecture'
                ? 'text-indigo-600 dark:text-indigo-400 underline underline-offset-8 decoration-2'
                : ''
            }`}
          >
            Architecture Blueprint
          </a>
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleNewConversation}
            className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 rounded-lg transition-colors whitespace-nowrap shrink-0"
          >
            New Chat
          </button>
        </div>
      </header>

      {!gatewayStatus.connected && (
        <div
          role="status"
          className="px-6 py-2 bg-rose-500/10 border-b border-rose-500/30 text-xs text-rose-600 dark:text-rose-300 flex items-center justify-between gap-4"
        >
          <span>
            <strong>AI Nexus Gateway Unreachable ({gatewayStatus.httpUrl}):</strong>{' '}
            Local Personal AI conversations remain active, but remote AI-to-AI invocations require{' '}
            <code className="font-mono">ai-nexus-gateway</code> running on port 4000.
          </span>
          <button
            type="button"
            onClick={() => fetchBootstrap(activeAiId)}
            className="px-2.5 py-1 rounded bg-rose-500/20 hover:bg-rose-500/30 text-rose-700 dark:text-rose-200 font-medium shrink-0"
          >
            Retry Gateway Connection
          </button>
        </div>
      )}

      {/* ====================================================================
          MAIN WORKSPACE BODY
         ==================================================================== */}
      {activeView === 'network' && (
        <main className="flex-1 overflow-y-auto">
          <NetworkPermissionsView
            identities={identities}
            activeAiId={activeAiId}
            permissionsByOwner={permissionsByOwner}
            pendingApprovals={pendingApprovals}
            queuedInvocations={invocations.filter((i) => i.queuedOffline)}
            onToggleNodeOnline={handleToggleNodeOnline}
            onToggleKillSwitch={handleToggleKillSwitch}
            onRotateKey={handleRotateKey}
            onVerifyPairing={handleVerifyPairing}
            onUpdatePermissionMode={handleUpdatePermissionMode}
            onResolveApproval={handleResolveApproval}
          />
        </main>
      )}

      {activeView === 'memory' && (
        <main className="flex-1 overflow-y-auto">
          <MemoryVaultView
            activeAiId={activeAiId}
            identities={identities}
            memoriesByOwner={memoriesByOwner}
            memoryGrants={memoryGrants}
            onAddMemory={handleAddMemory}
            onShareMemory={handleShareMemory}
            onRevokeGrant={handleRevokeGrant}
          />
        </main>
      )}

      {activeView === 'architecture' && (
        <main className="flex-1 overflow-y-auto">
          <ArchitectureBlueprintView auditEvents={auditEvents} />
        </main>
      )}

      {activeView === 'chat' && (
        <div className="flex-1 flex min-h-0 overflow-hidden">
          {/* ================================================================
              COLLAPSIBLE SIDEBAR (ChatGPT-Style Navigation & Identity Switcher)
             ================================================================ */}
          {sidebarOpen && (
            <aside
              aria-label="Conversation History & Personal AI Selector"
              className="w-72 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 flex flex-col justify-between shrink-0"
            >
              <div className="p-3.5 space-y-4 overflow-y-auto flex-1">
                {/* Active Personal AI Owner Perspective Switcher */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <label
                      htmlFor="active-ai-selector"
                      className="text-xs font-medium text-slate-500 dark:text-slate-400"
                    >
                      Active Personal AI Identity
                    </label>
                    <button
                      type="button"
                      aria-label="Collapse sidebar"
                      onClick={() => setSidebarOpen(false)}
                      className="p-1 rounded text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                    >
                      <PanelLeftClose className="w-4 h-4" />
                    </button>
                  </div>
                  <select
                    id="active-ai-selector"
                    value={activeAiId}
                    onChange={(e) => setActiveAiId(e.target.value)}
                    className="w-full text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  >
                    {identities.map((id) => (
                      <option key={id.aiId} value={id.aiId}>
                        {id.displayName} ({id.handle}) · {id.ownerDisplayName}
                      </option>
                    ))}
                  </select>
                  <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 tabular-nums px-1">
                    Mode: {activeIdentity.executionMode} · Model: {activeIdentity.configuredModel}
                  </div>
                </div>

                {/* Search Conversations */}
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    aria-label="Search conversations"
                    placeholder="Search conversations..."
                    value={sidebarSearch}
                    onChange={(e) => setSidebarSearch(e.target.value)}
                    className="w-full pl-8 pr-3 py-1.5 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                  />
                </div>

                {/* 1:1 Conversations List */}
                <div className="space-y-1">
                  <div className="px-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
                    Direct & AI-to-AI Threads
                  </div>
                  {filteredConversations
                    .filter((c) => !c.isGroup)
                    .map((conv) => {
                      const isActive = conv.id === activeConversation?.id;
                      return (
                        <div
                          key={conv.id}
                          className={`group flex items-center justify-between rounded-lg px-2.5 py-2 text-xs transition-colors ${
                            isActive
                              ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 font-medium'
                              : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60'
                          }`}
                        >
                          <button
                            type="button"
                            onClick={() => setActiveConversationId(conv.id)}
                            className="flex items-center gap-2 truncate flex-1 text-left"
                          >
                            <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">{conv.title}</span>
                          </button>
                          <div className="flex items-center gap-1 opacity-80 group-hover:opacity-100">
                            <button
                              type="button"
                              aria-label={`Pin conversation ${conv.title}`}
                              onClick={() => handleTogglePin(conv.id)}
                              className={`p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-700 ${
                                conv.pinned ? 'text-indigo-500' : 'text-slate-400'
                              }`}
                            >
                              <Pin className="w-3 h-3" />
                            </button>
                            {conversations.length > 1 && (
                              <button
                                type="button"
                                aria-label={`Delete conversation ${conv.title}`}
                                onClick={() => handleDeleteConversation(conv.id)}
                                className="p-1 rounded text-slate-400 hover:text-red-500"
                              >
                                <Trash2 className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                </div>

                {/* Group AI Conversations List */}
                <div className="space-y-1 pt-2 border-t border-slate-200 dark:border-slate-800">
                  <div className="px-2 flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                      Group AI Sessions (@alice · @bob · @charlie)
                    </span>
                    <button
                      type="button"
                      aria-label="Create new Group AI Session"
                      onClick={() => handleSendMessage('/group create Multi-AI Architecture Sync')}
                      className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-0.5"
                    >
                      <Plus className="w-3 h-3" />
                      New
                    </button>
                  </div>
                  {filteredConversations
                    .filter((c) => c.isGroup)
                    .map((conv) => {
                      const isActive = conv.id === activeConversation?.id;
                      return (
                        <button
                          key={conv.id}
                          type="button"
                          onClick={() => setActiveConversationId(conv.id)}
                          className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-xs text-left transition-colors ${
                            isActive
                              ? 'bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 font-medium'
                              : 'text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800/60'
                          }`}
                        >
                          <Users className="w-3.5 h-3.5 shrink-0 text-indigo-500" />
                          <span className="truncate">{conv.title}</span>
                        </button>
                      );
                    })}
                </div>

                {/* Connected Personal AI Network Quick Status */}
                <div className="space-y-1.5 pt-2 border-t border-slate-200 dark:border-slate-800">
                  <div className="px-2 text-xs font-semibold text-slate-500 dark:text-slate-400">
                    AI Nexus Gateway Peers
                  </div>
                  {identities.map((peer) => (
                    <div
                      key={peer.aiId}
                      className="px-2.5 py-1.5 rounded-lg text-xs flex items-center justify-between text-slate-600 dark:text-slate-400"
                    >
                      <div className="truncate">
                        <span className="font-medium text-slate-800 dark:text-slate-200">
                          {peer.displayName}
                        </span>{' '}
                        <span className="font-mono">{peer.handle}</span>
                      </div>
                      <span className="font-mono text-[11px] tabular-nums">
                        {peer.online ? 'ONLINE' : 'OFFLINE'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Sidebar Footer: Settings & User Profile */}
              <div className="p-3 border-t border-slate-200 dark:border-slate-800 space-y-2 bg-slate-50/50 dark:bg-slate-950/40">
                <button
                  type="button"
                  onClick={() => setSettingsOpen(true)}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs font-medium rounded-lg text-slate-700 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800 transition-colors"
                >
                  <span className="inline-flex items-center gap-2">
                    <Settings className="w-4 h-4 text-slate-500" />
                    Settings & Security Keys
                  </span>
                  <span className="font-mono text-[11px] text-slate-400">v1.0</span>
                </button>
              </div>
            </aside>
          )}

          {/* ================================================================
              MAIN CHAT THREAD & COMPOSER AREA
             ================================================================ */}
          <main className="flex-1 flex flex-col min-w-0 bg-white dark:bg-slate-950">
            {/* Conversation Context Header Bar */}
            <div className="px-6 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-4 bg-white/90 dark:bg-slate-900/60">
              <div className="flex items-center gap-3 min-w-0">
                {!sidebarOpen && (
                  <button
                    type="button"
                    aria-label="Open sidebar"
                    onClick={() => setSidebarOpen(true)}
                    className="p-1.5 rounded-lg border border-slate-200 dark:border-slate-800 text-slate-500 hover:text-slate-900 dark:hover:text-slate-100"
                  >
                    <PanelLeftOpen className="w-4 h-4" />
                  </button>
                )}
                <div className="min-w-0">
                  <h1 className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                    {activeConversation?.title ?? 'Personal AI Conversation'}
                  </h1>
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums truncate">
                    <span>Owner AI: {activeIdentity.displayName} ({activeIdentity.handle})</span>
                    <span className="mx-1.5">·</span>
                    <span>Gateway Protocol: v1.0 (Ed25519 Signed)</span>
                    {activeConversation?.isGroup && (
                      <>
                        <span className="mx-1.5">·</span>
                        <span className="text-indigo-600 dark:text-indigo-400">
                          Group Participants: @alice, @bob, @charlie
                        </span>
                      </>
                    )}
                  </div>
                </div>
              </div>

              {/* Quick Interactive Scenario Triggers for 1-Click E2E Verification */}
              <div className="flex items-center gap-2 overflow-x-auto">
                <button
                  type="button"
                  onClick={() =>
                    handleSendMessage('/ask @bob What is your availability tomorrow for a meeting?')
                  }
                  className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition-colors whitespace-nowrap"
                >
                  Run /ask @bob Availability
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handleSendMessage(
                      '/ask @bob Coordinate and confirm a meeting slot tomorrow afternoon'
                    )
                  }
                  className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition-colors whitespace-nowrap"
                >
                  Run Autonomous Follow-Up
                </button>
                <button
                  type="button"
                  onClick={() =>
                    handleSendMessage(
                      '/ask-all Review our Q4 launch proposal and identify the biggest risks.'
                    )
                  }
                  className="px-2.5 py-1.5 text-xs font-medium rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900 hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-300 transition-colors whitespace-nowrap"
                >
                  Run /ask-all Group Broadcast
                </button>
              </div>
            </div>

            {/* Messages Scroll Area */}
            <div className="flex-1 overflow-y-auto px-6 py-6">
              <div className="max-w-3xl mx-auto space-y-6">
                {activeConversation?.messages.map((msg) => {
                  const isUser = msg.role === 'user';
                  const isRemoteAi = msg.role === 'remote_ai';
                  const inv = msg.invocationRecord;
                  const isEnvelopeOpen = expandedEnvelopeMsgId === msg.id;

                  return (
                    <article
                      key={msg.id}
                      className={`flex flex-col ${isUser ? 'items-end' : 'items-start'}`}
                    >
                      {/* Sender & Attribution Header (Clean unboxed text with separators) */}
                      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400 mb-1.5 font-mono tabular-nums">
                        <span className="font-sans font-semibold text-slate-800 dark:text-slate-200">
                          {msg.senderDisplayName}
                        </span>
                        {msg.attributionLabel && (
                          <>
                            <span>·</span>
                            <span className="text-indigo-600 dark:text-indigo-400 font-sans">
                              {msg.attributionLabel}
                            </span>
                          </>
                        )}
                        <span>·</span>
                        <span>{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                      </div>

                      {/* Message Bubble / Surface */}
                      <div
                        className={`w-full rounded-xl p-4 border ${
                          isUser
                            ? 'max-w-xl bg-slate-900 text-white dark:bg-indigo-600/20 dark:border-indigo-500/30 dark:text-slate-100 border-slate-800'
                            : isRemoteAi
                            ? 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-800 text-slate-900 dark:text-slate-100'
                            : 'bg-white dark:bg-slate-900/60 border-slate-200 dark:border-slate-800/80 text-slate-900 dark:text-slate-100'
                        }`}
                      >
                        <div className="text-sm leading-relaxed space-y-2">
                          {msg.content.split('\n\n').map((block, bIdx) => {
                            if (block.startsWith('```') && block.endsWith('```')) {
                              const codeLines = block.slice(3, -3).trim();
                              return (
                                <div
                                  key={bIdx}
                                  className="rounded-lg bg-slate-950 text-slate-100 p-3 font-mono text-xs overflow-x-auto border border-slate-800"
                                >
                                  <pre>{codeLines}</pre>
                                </div>
                              );
                            }
                            return (
                              <p key={bIdx} className="whitespace-pre-wrap">
                                {block
                                  .split(/(\*\*[^*]+\*\*|`[^`]+`|\*\([^)]+\)\*)/g)
                                  .map((part, pIdx) => {
                                    if (part.startsWith('**') && part.endsWith('**')) {
                                      return (
                                        <strong
                                          key={pIdx}
                                          className="font-semibold text-slate-950 dark:text-white"
                                        >
                                          {part.slice(2, -2)}
                                        </strong>
                                      );
                                    }
                                    if (part.startsWith('`') && part.endsWith('`')) {
                                      return (
                                        <code
                                          key={pIdx}
                                          className="px-1.5 py-0.5 rounded bg-slate-200/80 dark:bg-slate-800 font-mono text-xs text-indigo-600 dark:text-indigo-300"
                                        >
                                          {part.slice(1, -1)}
                                        </code>
                                      );
                                    }
                                    if (part.startsWith('*(') && part.endsWith(')*')) {
                                      return (
                                        <em
                                          key={pIdx}
                                          className="text-xs text-slate-500 dark:text-slate-400 not-italic block mt-1"
                                        >
                                          {part.slice(1, -1)}
                                        </em>
                                      );
                                    }
                                    return <React.Fragment key={pIdx}>{part}</React.Fragment>;
                                  })}
                              </p>
                            );
                          })}
                        </div>

                        {/* Attachments if any */}
                        {msg.attachments && msg.attachments.length > 0 && (
                          <div className="mt-3 pt-2 border-t border-slate-200/40 dark:border-slate-800 flex flex-wrap gap-2 text-xs font-mono">
                            {msg.attachments.map((att) => (
                              <span key={att.id} className="text-indigo-400">
                                Attached: {att.name} ({att.sizeLabel})
                              </span>
                            ))}
                          </div>
                        )}

                        {/* Remote Invocation Cryptographic Lifecycle & Minimization Inspector */}
                        {inv && (
                          <div className="mt-4 pt-3 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                              <div>
                                State:{' '}
                                <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                                  {inv.state}
                                </span>{' '}
                                · Req: {inv.requestId} · Capability: {inv.capability}
                              </div>
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedEnvelopeMsgId(isEnvelopeOpen ? null : msg.id)
                                }
                                className="text-indigo-600 dark:text-indigo-400 hover:underline inline-flex items-center gap-1 font-sans font-medium"
                              >
                                {isEnvelopeOpen ? (
                                  <>
                                    <ChevronDown className="w-3.5 h-3.5" />
                                    Hide Gateway Envelope & State Trace
                                  </>
                                ) : (
                                  <>
                                    <ChevronRight className="w-3.5 h-3.5" />
                                    Inspect Gateway Envelope & State Trace ({inv.transitions.length} steps)
                                  </>
                                )}
                              </button>
                            </div>

                            {isEnvelopeOpen && (
                              <div className="p-3.5 rounded-lg bg-slate-100 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-3 text-xs font-mono">
                                <div>
                                  <div className="text-slate-500 dark:text-slate-400 mb-1.5 font-sans font-semibold">
                                    Invocation Lifecycle State Machine:
                                  </div>
                                  <div className="space-y-1">
                                    {inv.transitions.map((tr, idx) => (
                                      <div
                                        key={idx}
                                        className="flex items-start gap-2 text-[11px] text-slate-700 dark:text-slate-300"
                                      >
                                        <span className="text-indigo-600 dark:text-indigo-400 font-semibold min-w-[125px]">
                                          {idx + 1}. {tr.state}
                                        </span>
                                        <span className="text-slate-500">[{tr.actor}]</span>
                                        <span className="font-sans">{tr.summary}</span>
                                      </div>
                                    ))}
                                  </div>
                                </div>

                                {(msg.minimizedFields || msg.redactedFields) && (
                                  <div className="pt-2 border-t border-slate-200 dark:border-slate-800 grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
                                    <div>
                                      <span className="text-emerald-600 dark:text-emerald-400 font-semibold">
                                        Authorized Minimized Fields:
                                      </span>{' '}
                                      {msg.minimizedFields?.join(', ') || 'None'}
                                    </div>
                                    <div>
                                      <span className="text-amber-600 dark:text-amber-400 font-semibold">
                                        Redacted Private Fields:
                                      </span>{' '}
                                      {msg.redactedFields?.join(', ') || 'None'}
                                    </div>
                                  </div>
                                )}

                                <div className="pt-2 border-t border-slate-200 dark:border-slate-800 text-[11px] text-slate-500 truncate">
                                  Ed25519 Signature: {inv.envelope.security.signature} · Nonce:{' '}
                                  {inv.envelope.security.nonce}
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* Message Actions Row */}
                        {!isUser && (
                          <div className="mt-3 pt-2 flex items-center justify-between text-xs text-slate-400">
                            <div className="flex items-center gap-3">
                              <button
                                type="button"
                                onClick={() => handleCopyMessage(msg)}
                                className="hover:text-slate-700 dark:hover:text-slate-200 inline-flex items-center gap-1 transition-colors"
                              >
                                {copiedMsgId === msg.id ? (
                                  <>
                                    <Check className="w-3.5 h-3.5 text-emerald-500" />
                                    Copied
                                  </>
                                ) : (
                                  <>
                                    <Copy className="w-3.5 h-3.5" />
                                    Copy
                                  </>
                                )}
                              </button>
                            </div>
                            {msg.tokensUsed && (
                              <span className="font-mono text-[11px] tabular-nums">
                                {msg.modelUsed ?? 'gemini-3.8-flash'} · {msg.tokensUsed} tokens · $
                                {(msg.costUsd ?? 0.0003).toFixed(4)}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </article>
                  );
                })}

                {/* Real-time AI-to-AI Communication Progress Indicator */}
                {statusActivityText && (
                  <div
                    role="status"
                    className="p-4 rounded-xl border border-indigo-500/30 bg-indigo-500/5 text-xs font-mono text-indigo-600 dark:text-indigo-300 flex items-center gap-3"
                  >
                    <RefreshCw className="w-4 h-4 animate-spin shrink-0" />
                    <span>{statusActivityText}</span>
                  </div>
                )}

                <div ref={messagesEndRef} />
              </div>
            </div>

            {/* ==============================================================
                POLISHED INPUT COMPOSER (Commands, @Recipient, Attachments)
               ============================================================== */}
            <div className="px-6 py-4 border-t border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
              <div className="max-w-3xl mx-auto space-y-2.5">
                {/* Command Autocomplete & Discovery Popover */}
                {showCommandHelper && (
                  <div className="p-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 space-y-1.5 shadow-lg">
                    <div className="flex items-center justify-between text-xs font-semibold text-slate-500 dark:text-slate-400 px-1">
                      <span>AI Nexus Native AI-to-AI Commands & Scenarios</span>
                      <button
                        type="button"
                        onClick={() => setShowCommandHelper(false)}
                        className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                      >
                        Close
                      </button>
                    </div>
                    <div className="divide-y divide-slate-200/70 dark:divide-slate-800/70 max-h-48 overflow-y-auto">
                      {SLASH_COMMANDS.map((item, idx) => (
                        <button
                          key={idx}
                          type="button"
                          onClick={() => {
                            setComposerText(item.cmd);
                            setShowCommandHelper(false);
                          }}
                          className="w-full text-left py-2 px-2 hover:bg-indigo-50 dark:hover:bg-indigo-950/40 rounded transition-colors flex flex-col sm:flex-row sm:items-center justify-between gap-1"
                        >
                          <code className="text-xs font-mono text-indigo-600 dark:text-indigo-400 font-semibold">
                            {item.cmd}
                          </code>
                          <span className="text-xs text-slate-500 dark:text-slate-400">
                            {item.desc}
                          </span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Pending Attachments Strip */}
                {attachments.length > 0 && (
                  <div className="flex items-center gap-2 text-xs font-mono text-slate-600 dark:text-slate-300">
                    {attachments.map((att) => (
                      <span
                        key={att.id}
                        className="px-2.5 py-1 rounded bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700"
                      >
                        {att.name} ({att.sizeLabel})
                      </span>
                    ))}
                    <button
                      type="button"
                      onClick={() => setAttachments([])}
                      className="text-red-500 hover:underline font-sans"
                    >
                      Clear
                    </button>
                  </div>
                )}

                {/* Composer Box */}
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    handleSendMessage();
                  }}
                  className="rounded-xl border border-slate-300 dark:border-slate-700 bg-slate-50 dark:bg-slate-950 focus-within:ring-2 focus-within:ring-indigo-500 p-3 space-y-2.5"
                >
                  <textarea
                    rows={2}
                    aria-label="Message or AI-to-AI command input"
                    value={composerText}
                    onChange={(e) => {
                      setComposerText(e.target.value);
                      if (e.target.value === '/') {
                        setShowCommandHelper(true);
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendMessage();
                      }
                    }}
                    placeholder={`Message ${activeIdentity.displayName} or type /ask @bob What is your availability tomorrow?`}
                    className="w-full bg-transparent text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none resize-none"
                  />

                  <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200 dark:border-slate-800/80">
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={() => setShowCommandHelper((prev) => !prev)}
                        className="px-2.5 py-1 text-xs font-mono font-medium rounded-md bg-slate-200/80 dark:bg-slate-800 text-slate-700 dark:text-slate-300 hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors whitespace-nowrap"
                      >
                        / Commands & @AIs
                      </button>

                      <button
                        type="button"
                        onClick={handleAddDemoAttachment}
                        className="p-1.5 rounded-md text-slate-500 hover:text-slate-900 dark:hover:text-slate-100 hover:bg-slate-200/60 dark:hover:bg-slate-800 transition-colors inline-flex items-center gap-1 text-xs"
                        title="Attach proposal document"
                      >
                        <Paperclip className="w-3.5 h-3.5" />
                        <span>Attach</span>
                      </button>

                      <label className="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-400 cursor-pointer select-none px-1">
                        <input
                          type="checkbox"
                          checked={autonomousFollowUp}
                          onChange={(e) => setAutonomousFollowUp(e.target.checked)}
                          className="accent-indigo-600 rounded"
                        />
                        <span>Autonomous Follow-Up (Max 5 turns)</span>
                      </label>
                    </div>

                    <div className="flex items-center gap-3">
                      <span className="hidden sm:inline text-xs font-mono text-slate-400 tabular-nums">
                        {activeIdentity.configuredModel}
                      </span>
                      <button
                        type="submit"
                        disabled={isSending || !composerText.trim()}
                        aria-label="Send message"
                        className="px-4 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 rounded-lg transition-colors inline-flex items-center gap-1.5 whitespace-nowrap"
                      >
                        <Send className="w-3.5 h-3.5" />
                        <span>Send</span>
                      </button>
                    </div>
                  </div>
                </form>
              </div>
            </div>
          </main>
        </div>
      )}

      {/* Settings Modal */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        activeIdentity={activeIdentity}
        identities={identities}
        darkMode={darkMode}
        onToggleDarkMode={() => setDarkMode((d) => !d)}
        autonomousFollowUpDefault={autonomousFollowUp}
        onToggleAutonomousFollowUp={setAutonomousFollowUp}
        onUpdateModel={handleUpdateModel}
        onToggleNodeOnline={handleToggleNodeOnline}
        onRotateKey={handleRotateKey}
        totalInvocations={invocations.length}
      />
    </div>
  );
}

export default App;
