import type { AcpNotificationMessage, AcpRequestMessage, AcpResponseMessage } from "@agen-ai/acp-transport";

// Unmodified frames from credential-free Grok Build 1.0.62, MS005 native r1.
// Source: ms005-native-r1/grok-tools/case-report.json; selected nativeEvents sequences 1, 2, 4, 14, 16.
// Source file SHA256: d42a855fb7f2c55c87b720abfff8db95778f11736c9435e2d5712b9f3ed72010.

export const nativeInitializeRequest: AcpRequestMessage = {
  "jsonrpc": "2.0",
  "id": 1,
  "method": "initialize",
  "params": {
    "protocolVersion": 1,
    "clientInfo": {
      "name": "agenai-ms005-native-fixture",
      "version": "1.0.0"
    },
    "clientCapabilities": {
      "fs": {
        "readTextFile": true,
        "writeTextFile": true
      },
      "terminal": false,
      "session": {
        "configOptions": {
          "boolean": {}
        }
      }
    }
  }
};

export const nativeInitializeResponse: AcpResponseMessage = {
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "agentCapabilities": {
      "loadSession": true,
      "promptCapabilities": {
        "image": false,
        "audio": false,
        "embeddedContext": true
      },
      "mcpCapabilities": {
        "http": true,
        "sse": true
      },
      "sessionCapabilities": {
        "list": {},
        "resume": {},
        "close": {}
      },
      "auth": {},
      "_meta": {
        "x.ai/fs_notify": true,
        "x.ai/hooks": {
          "blockingEvents": [
            "pre_tool_use",
            "stop",
            "subagent_stop"
          ],
          "decisions": [
            "deny",
            "block"
          ],
          "stopSignals": [
            "continue",
            "stopReason",
            "additionalContext"
          ]
        },
        "x.ai/capabilities": {
          "toolOverrides": {
            "x_keyword_search": true,
            "x_semantic_search": true,
            "x_user_search": false,
            "x_thread_fetch": false
          }
        }
      }
    },
    "authMethods": [
      {
        "id": "xai.api_key",
        "name": "xai.api_key",
        "description": "XAI_API_KEY or api_key/env_key in config.toml"
      },
      {
        "id": "grok.com",
        "name": "Grok",
        "description": "Sign in with Grok"
      }
    ],
    "_meta": {
      "currentWorkingDirectory": "/workspace/work",
      "agentVersion": "1.0.62",
      "agentId": "85e74316-044a-5507-bcd6-a4e433142259",
      "agentInstanceId": "846d700e-fd57-46e1-9932-57fd91528a76",
      "hostname": "b42611b12b6b",
      "metadata": null,
      "grokShell": true,
      "defaultAuthMethodId": "xai.api_key",
      "x.ai/mcp/sdk": true,
      "x.ai/pluginDirs": true,
      "modelState": {
        "currentModelId": "grok-4.3",
        "availableModels": [
          {
            "modelId": "grok-4.3",
            "name": "grok-4.3",
            "_meta": {
              "totalContextTokens": 256000,
              "agentType": "grok-build-plan",
              "supportsReasoningEffort": true,
              "reasoningEffort": "low",
              "reasoningEfforts": [
                {
                  "id": "none",
                  "value": "none",
                  "label": "None",
                  "description": null,
                  "default": false
                },
                {
                  "id": "low",
                  "value": "low",
                  "label": "Low",
                  "description": null,
                  "default": true
                },
                {
                  "id": "medium",
                  "value": "medium",
                  "label": "Medium",
                  "description": null,
                  "default": false
                },
                {
                  "id": "high",
                  "value": "high",
                  "label": "High",
                  "description": null,
                  "default": false
                },
                {
                  "id": "xhigh",
                  "value": "xhigh",
                  "label": "X-High",
                  "description": null,
                  "default": false
                }
              ]
            }
          }
        ]
      },
      "mcpServers": [],
      "mcpApps": false,
      "availableCommands": [
        {
          "name": "compact",
          "description": "Compress conversation history to save context window",
          "input": null
        },
        {
          "name": "always-approve",
          "description": "Toggle always-approve mode (skip all permission prompts)",
          "input": {
            "hint": "on|off"
          }
        },
        {
          "name": "context",
          "description": "Show context window usage and session stats",
          "input": null
        },
        {
          "name": "session-info",
          "description": "Show session details (model, turns, context usage)",
          "input": null
        },
        {
          "name": "deep-research",
          "description": "Research with bounded parallel agents, cross-check evidence, and write a cited report",
          "input": {
            "hint": "<query>"
          }
        },
        {
          "name": "workflow",
          "description": "Launch a saved workflow, list runs, or manage a run (pause, resume, stop, save)",
          "input": {
            "hint": "<name> [--agent-budget N] [--effort LEVEL] [args] | runs | pause|resume|stop|save [name]"
          }
        },
        {
          "name": "goal",
          "description": "Set, manage, or check an autonomous goal",
          "input": {
            "hint": "<objective> [--budget <tokens>] | status | pause | resume | clear"
          }
        }
      ],
      "cancelRewind": true,
      "sessionRecap": true,
      "feedbackTraceOffer": false,
      "voiceMode": true
    }
  }
};

export const nativeNewSessionRequest: AcpRequestMessage = {
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session/new",
  "params": {
    "cwd": "/workspace/work",
    "mcpServers": [],
    "_meta": {
      "clientFsRead": true,
      "clientFsWrite": true,
      "clientTerminal": false
    }
  }
};

export const nativeNewSessionResponse: AcpResponseMessage = {
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "sessionId": "01a1732d-cfc5-7110-b6b6-edbca11b5ec6",
    "models": {
      "currentModelId": "grok-4.3",
      "availableModels": [
        {
          "modelId": "grok-4.3",
          "name": "grok-4.3",
          "_meta": {
            "totalContextTokens": 256000,
            "agentType": "grok-build-plan",
            "supportsReasoningEffort": true,
            "reasoningEffort": "low",
            "reasoningEfforts": [
              {
                "id": "none",
                "value": "none",
                "label": "None",
                "description": null,
                "default": false
              },
              {
                "id": "low",
                "value": "low",
                "label": "Low",
                "description": null,
                "default": true
              },
              {
                "id": "medium",
                "value": "medium",
                "label": "Medium",
                "description": null,
                "default": false
              },
              {
                "id": "high",
                "value": "high",
                "label": "High",
                "description": null,
                "default": false
              },
              {
                "id": "xhigh",
                "value": "xhigh",
                "label": "X-High",
                "description": null,
                "default": false
              }
            ]
          }
        }
      ]
    },
    "configOptions": [
      {
        "id": "model",
        "name": "Model",
        "category": "model",
        "type": "select",
        "currentValue": "grok-4.3",
        "options": [
          {
            "value": "grok-4.3",
            "name": "grok-4.3"
          }
        ]
      },
      {
        "id": "reasoning_effort",
        "name": "Reasoning Effort",
        "category": "thought_level",
        "type": "select",
        "currentValue": "low",
        "options": [
          {
            "value": "none",
            "name": "None"
          },
          {
            "value": "low",
            "name": "Low"
          },
          {
            "value": "medium",
            "name": "Medium"
          },
          {
            "value": "high",
            "name": "High"
          },
          {
            "value": "xhigh",
            "name": "X-High"
          }
        ]
      }
    ],
    "_meta": {
      "currentWorkingDirectory": "/workspace/work",
      "isGitRepo": false,
      "gitRoot": null,
      "showNonGitWarning": false,
      "feedbackEnabled": true,
      "codebaseIndexed": [],
      "x.ai/sessionConfig": {
        "options": [
          {
            "id": "grok-4.3",
            "category": "model",
            "label": "grok-4.3",
            "selected": true
          },
          {
            "id": "none",
            "category": "mode",
            "label": "None",
            "selected": false
          },
          {
            "id": "low",
            "category": "mode",
            "label": "Low",
            "selected": true
          },
          {
            "id": "medium",
            "category": "mode",
            "label": "Medium",
            "selected": false
          },
          {
            "id": "high",
            "category": "mode",
            "label": "High",
            "selected": false
          },
          {
            "id": "xhigh",
            "category": "mode",
            "label": "X-High",
            "selected": false
          }
        ]
      },
      "x.ai/sessionDetail": {
        "sessionId": "01a1732d-cfc5-7110-b6b6-edbca11b5ec6",
        "kind": "build",
        "cwd": "/workspace/work",
        "currentModelId": "grok-4.3"
      },
      "x.ai/memoryNotesWritable": false
    }
  }
};

export const nativeAvailableCommandsUpdate: AcpNotificationMessage = {
  "jsonrpc": "2.0",
  "method": "session/update",
  "params": {
    "sessionId": "01a1732d-cfc5-7110-b6b6-edbca11b5ec6",
    "update": {
      "sessionUpdate": "available_commands_update",
      "availableCommands": [
        {
          "name": "compact",
          "description": "Compress conversation history to save context window",
          "input": null
        },
        {
          "name": "always-approve",
          "description": "Toggle always-approve mode (skip all permission prompts)",
          "input": {
            "hint": "on|off"
          }
        },
        {
          "name": "context",
          "description": "Show context window usage and session stats",
          "input": null
        },
        {
          "name": "session-info",
          "description": "Show session details (model, turns, context usage)",
          "input": null
        },
        {
          "name": "feedback",
          "description": "Send feedback about the current session",
          "input": {
            "hint": "feedback text"
          }
        },
        {
          "name": "deep-research",
          "description": "Research with bounded parallel agents, cross-check evidence, and write a cited report",
          "input": {
            "hint": "<query>"
          },
          "_meta": {
            "workflowSource": "builtin",
            "workflowPath": "/buildkite/builds/buildkite-agent-ci-cpu-cuda-xlarge-689bfdbf7f-26g26-1/xai/spacexai-checks/crates/codegen/xai-grok-shell/src/session/workflows/deep_research.rhai"
          }
        },
        {
          "name": "workflow",
          "description": "Launch a saved workflow, list runs, or manage a run (pause, resume, stop, save)",
          "input": {
            "hint": "<name> [--agent-budget N] [--effort LEVEL] [args] | runs | pause|resume|stop|save [name]"
          }
        },
        {
          "name": "goal",
          "description": "Set, manage, or check an autonomous goal",
          "input": {
            "hint": "<objective> [--budget <tokens>] | status | pause | resume | clear"
          }
        },
        {
          "name": "loop",
          "description": "Run a prompt on a recurring interval",
          "input": {
            "hint": "[interval] <prompt>"
          }
        }
      ],
      "_meta": {
        "tools": [
          "run_terminal_command",
          "read_file",
          "search_replace",
          "list_dir",
          "grep",
          "kill_command_or_subagent",
          "todo_write",
          "get_command_or_subagent_output",
          "spawn_subagent",
          "scheduler_create",
          "scheduler_delete",
          "scheduler_list",
          "monitor",
          "search_tool",
          "use_tool",
          "workflow",
          "enter_plan_mode",
          "exit_plan_mode",
          "ask_user_question",
          "send_feedback",
          "web_search",
          "image_gen",
          "image_edit",
          "image_to_video",
          "reference_to_video",
          "write"
        ]
      }
    },
    "_meta": {
      "totalTokens": 1325,
      "requestTrimmedTokens": 0,
      "eventId": "01a1732d-cfc5-7110-b6b6-edbca11b5ec6-0",
      "agentTimestampMs": 1792933744597,
      "updateType": "AvailableCommandsUpdate",
      "updateParams": {
        "commandsCount": 9
      }
    }
  }
};
