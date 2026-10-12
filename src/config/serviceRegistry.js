/**
 * Service Registry - Centralized service definitions with documentation
 *
 * Contains:
 * - Service metadata and configuration
 * - Dependencies between services
 * - Troubleshooting tips
 * - Health check thresholds
 * - Documentation links
 */

const FILES_SERVICE_HEALTH_URL = import.meta.env.DEV ? '/files-api/health' : '/files/health'

export const SERVICE_REGISTRY = {
  quoxagent: {
    name: 'QuoxAgent',
    shortName: 'QuoxAgent',
    containerName: null,
    restartable: false,
    description: 'Local Quox Helper Agent for host management',
    longDescription: 'The QuoxAgent Agent runs on each managed host and provides SSH command execution, file management, system monitoring, and plugin capabilities. It communicates with the Collector to report fleet status.',
    port: 9847,
    category: 'core',
    critical: true,
    icon: 'agent',
    color: '#a78bfa',

    // Health check configuration
    healthEndpoint: '/health',
    healthTimeout: 5000,
    thresholds: {
      responseTime: { warning: 500, critical: 2000 },
      uptimePercent: { warning: 99, critical: 95 }
    },

    // Dependencies
    dependencies: [],
    dependents: ['collector'],

    // Documentation
    docs: {
      configPath: '/etc/quoxagent/quoxagent.yaml',
      logsPath: '/var/log/quoxagent/',
      binaryPath: '/opt/quoxagent/bin/quoxagent',
      systemdService: 'quoxagent.service'
    },

    // Troubleshooting
    troubleshooting: [
      {
        symptom: 'Service not responding',
        checks: [
          'Verify the service is running: systemctl status quoxagent',
          'Check if port 9847 is open: ss -tlnp | grep 9847',
          'Review logs: journalctl -u quoxagent -f'
        ],
        solution: 'Restart the service: sudo systemctl restart quoxagent'
      },
      {
        symptom: 'Missing endpoints',
        checks: [
          'Check QuoxAgent version: quoxagent --version',
          'Verify plugins are installed: ls /opt/quoxagent/tools/'
        ],
        solution: 'Update QuoxAgent to latest version or reinstall plugins'
      }
    ],

    // Links
    links: [
      { label: 'Documentation', url: '/docs/quoxagent' },
      { label: 'API Reference', url: '/quoxagent-agent/api/v1/status' }
    ]
  },

  collector: {
    name: 'Collector',
    shortName: 'Collector',
    containerName: 'collector',
    restartable: true,
    description: 'Fleet heartbeat aggregator and management',
    longDescription: 'The Collector service aggregates heartbeats from all QuoxAgent agents across the fleet, provides real-time fleet status via WebSocket, and exposes REST APIs for fleet management and AI chat streaming.',
    port: 9848,
    category: 'core',
    critical: true,
    icon: 'server',
    color: '#38bdf8',

    healthEndpoint: '/health',
    healthTimeout: 5000,
    thresholds: {
      responseTime: { warning: 300, critical: 1000 },
      uptimePercent: { warning: 99.5, critical: 99 }
    },

    dependencies: ['quoxagent'],
    dependents: ['dashboard'],

    docs: {
      configPath: '/opt/quoxcore/services/collector/.env',
      logsPath: 'Docker logs or systemd journal',
      serverFile: '/opt/quoxcore/services/collector/server.js'
    },

    troubleshooting: [
      {
        symptom: 'Service not responding',
        checks: [
          'Check if Node.js process is running: pgrep -f collector',
          'Verify port 9848: curl -s http://localhost:9848/health',
          'Check environment variables are set'
        ],
        solution: 'Restart collector service or check for port conflicts'
      },
      {
        symptom: 'WebSocket disconnections',
        checks: [
          'Check nginx proxy configuration for WebSocket timeouts',
          'Verify no firewall blocking WebSocket upgrades'
        ],
        solution: 'Increase nginx proxy_read_timeout for /collector/ws'
      }
    ],

    links: [
      { label: 'Fleet Status', url: '/collector/api/v1/fleet/status' },
      { label: 'Metrics', url: '/collector/metrics' }
    ]
  },

  auth: {
    name: 'Auth Service',
    shortName: 'Auth',
    containerName: 'auth',
    restartable: true,
    description: 'Authentication and authorization',
    longDescription: 'Handles user authentication (JWT), organization management, RBAC permissions, MFA (TOTP), and audit logging. Provides secure session management for the dashboard.',
    port: 3101,
    category: 'core',
    critical: true,
    icon: 'shield',
    color: '#30ff90',

    healthEndpoint: '/health',
    healthTimeout: 5000,
    thresholds: {
      responseTime: { warning: 200, critical: 1000 },
      uptimePercent: { warning: 99.9, critical: 99.5 }
    },

    dependencies: [],
    dependents: ['dashboard'],

    docs: {
      configPath: '/opt/quoxcore/services/auth/.env',
      databasePath: '/opt/quoxcore/services/auth/data/auth.db',
      serverFile: '/opt/quoxcore/services/auth/server.js'
    },

    troubleshooting: [
      {
        symptom: 'Login failures',
        checks: [
          'Verify JWT_SECRET is set in .env',
          'Check database file permissions',
          'Review auth logs for specific errors'
        ],
        solution: 'Ensure all required environment variables are configured'
      },
      {
        symptom: 'Token expiration issues',
        checks: [
          'Check JWT_ACCESS_EXPIRY and JWT_REFRESH_EXPIRY settings',
          'Verify server time is synchronized (NTP)'
        ],
        solution: 'Adjust token expiry times or fix server clock'
      }
    ],

    links: [
      { label: 'Health Check', url: '/health' },
      { label: 'Setup Wizard', url: '/api/setup/status' }
    ]
  },

  qdrant: {
    name: 'Qdrant',
    shortName: 'Qdrant',
    containerName: 'qdrant',
    restartable: true,
    description: 'Vector database for semantic search',
    longDescription: 'Qdrant stores vector embeddings for semantic memory search, enabling intelligent retrieval of conversation history, documents, and entity information.',
    port: 6333,
    category: 'data',
    critical: false,
    icon: 'database',
    color: '#9d4edd',

    healthEndpoint: '/',
    healthTimeout: 5000,
    thresholds: {
      responseTime: { warning: 100, critical: 500 },
      uptimePercent: { warning: 99, critical: 95 }
    },

    dependencies: [],
    dependents: ['dashboard'],

    docs: {
      configPath: 'Docker environment',
      dataPath: '/opt/quoxcore/qdrant-data',
      dockerCompose: '/opt/quoxcore/docker-compose.yml'
    },

    troubleshooting: [
      {
        symptom: 'Service not responding',
        checks: [
          'Check Docker container: docker ps | grep qdrant',
          'Verify disk space for vector storage',
          'Check container logs: docker logs quox-qdrant'
        ],
        solution: 'Restart container or free up disk space'
      },
      {
        symptom: 'Slow queries',
        checks: [
          'Check collection sizes and index status',
          'Monitor memory usage of Qdrant container',
          'Review query patterns for optimization'
        ],
        solution: 'Optimize indexes or increase container memory'
      }
    ],

    links: [
      { label: 'Qdrant Dashboard', url: 'http://localhost:6333/dashboard' },
      { label: 'Collections', url: '/qdrant/collections' }
    ]
  },

  orchestrator: {
    name: 'Orchestrator',
    shortName: 'Orchestrator',
    containerName: 'orchestrator',
    restartable: false,
    description: 'Container lifecycle management',
    longDescription: 'Manages sandboxed container execution for tool operations. Spawns isolated containers for code execution, file processing, and other potentially unsafe operations.',
    port: 3100,
    category: 'infrastructure',
    critical: false,
    icon: 'container',
    color: '#4ecdc4',

    healthEndpoint: '/health',
    healthTimeout: 5000,
    thresholds: {
      responseTime: { warning: 200, critical: 1000 },
      uptimePercent: { warning: 95, critical: 90 }
    },

    dependencies: [],
    dependents: ['dashboard'],

    docs: {
      configPath: '/opt/quoxcore/services/orchestrator/.env',
      serverFile: '/opt/quoxcore/services/orchestrator/server.js',
      sandboxImages: 'quox-sandbox:restricted, quox-sandbox:standard'
    },

    troubleshooting: [
      {
        symptom: 'Container spawn failures',
        checks: [
          'Verify Docker daemon is running',
          'Check sandbox images exist: docker images | grep quox-sandbox',
          'Review orchestrator logs'
        ],
        solution: 'Build sandbox images or restart Docker daemon'
      },
      {
        symptom: 'Timeout errors',
        checks: [
          'Check DEFAULT_TIMEOUT configuration',
          'Monitor container resource usage',
          'Verify network connectivity for containers'
        ],
        solution: 'Increase timeout or reduce container workload'
      }
    ],

    links: [
      { label: 'Health Check', url: '/orchestrator/health' },
      { label: 'Active Containers', url: '/orchestrator/status' }
    ]
  },

  nginx: {
    name: 'Nginx',
    shortName: 'Nginx',
    containerName: 'dashboard',
    restartable: true,
    description: 'Reverse proxy & TLS termination',
    longDescription: 'Nginx serves as the primary reverse proxy, handling SSL termination, request routing to backend services, WebSocket proxying, and rate limiting.',
    port: 443,
    category: 'infrastructure',
    critical: true,
    icon: 'globe',
    color: '#22c55e',

    healthEndpoint: null, // Implicit - if page loads, nginx works
    healthTimeout: 5000,
    thresholds: {
      responseTime: { warning: 50, critical: 200 },
      uptimePercent: { warning: 99.9, critical: 99.5 }
    },

    dependencies: [],
    dependents: ['dashboard', 'auth', 'collector'],

    docs: {
      configPath: '/opt/quoxcore/nginx.conf',
      sslCertPath: '/etc/nginx/ssl/quox.crt',
      sslKeyPath: '/etc/nginx/ssl/quox.key',
      systemdService: 'nginx.service'
    },

    troubleshooting: [
      {
        symptom: 'Connection refused',
        checks: [
          'Verify nginx is running: systemctl status nginx',
          'Check port 443 is listening: ss -tlnp | grep 443',
          'Validate config: nginx -t'
        ],
        solution: 'Fix configuration errors and restart: systemctl restart nginx'
      },
      {
        symptom: 'SSL certificate errors',
        checks: [
          'Check certificate expiration: openssl x509 -enddate -noout -in /etc/nginx/ssl/quox.crt',
          'Verify certificate chain is complete',
          'Ensure key file permissions are correct'
        ],
        solution: 'Renew certificate or fix permissions (chmod 600 for key)'
      },
      {
        symptom: 'Upstream timeouts',
        checks: [
          'Check if backend service is running',
          'Review proxy_read_timeout settings',
          'Monitor backend response times'
        ],
        solution: 'Increase timeout or fix slow backend service'
      }
    ],

    links: [
      { label: 'Nginx Status', url: '/nginx_status' },
      { label: 'Config File', url: 'file:///opt/quoxcore/nginx.conf' }
    ]
  },

  memory: {
    name: 'Memory Service',
    shortName: 'Memory',
    containerName: 'memory',
    restartable: true,
    description: 'Server-side memory persistence',
    longDescription: 'Provides server-side memory persistence with SQLite + FTS5 full-text search. Stores facts, preferences, decisions, entities, and error/fix patterns. Used by agents via memory_save/memory_search tools.',
    port: 3103,
    category: 'data',
    critical: false,
    icon: 'database',
    color: '#f472b6',

    healthEndpoint: '/health',
    healthTimeout: 5000,
    thresholds: {
      responseTime: { warning: 200, critical: 1000 },
      uptimePercent: { warning: 99, critical: 95 }
    },

    dependencies: ['auth'],
    dependents: ['collector'],

    docs: {
      configPath: '/opt/quoxcore/services/memory/.env',
      databasePath: '/var/lib/quox/memory.db',
      serverFile: '/opt/quoxcore/services/memory/server.js'
    },

    troubleshooting: [
      {
        symptom: 'Service not responding',
        checks: [
          'Check container status: docker ps | grep quox-memory',
          'Verify port 3103: curl -s http://127.0.0.1:3103/health',
          'Review logs: docker logs quox-memory -f'
        ],
        solution: 'Restart the container: docker restart quox-memory'
      },
      {
        symptom: 'Search returning no results',
        checks: [
          'Verify FTS5 index is populated',
          'Check database file size and integrity',
          'Review memory save operations in logs'
        ],
        solution: 'Rebuild FTS index or check DB path permissions'
      }
    ],

    links: [
      { label: 'Health Check', url: '/memory/health' }
    ]
  },

  files: {
    name: 'File Service',
    shortName: 'Files',
    containerName: 'files',
    restartable: true,
    description: 'File storage and operations',
    longDescription: 'Handles file upload, storage, and management. Provides CRUD operations for files and folders, used by the ARCHIVIST agent for document summarization, comparison, and extraction.',
    port: 3102,
    category: 'data',
    critical: false,
    icon: 'folder',
    color: '#60a5fa',

    healthEndpoint: '/health',
    healthTimeout: 5000,
    thresholds: {
      responseTime: { warning: 200, critical: 1000 },
      uptimePercent: { warning: 99, critical: 95 }
    },

    dependencies: [],
    dependents: ['dashboard'],

    docs: {
      configPath: '/opt/quoxcore/services/files/.env',
      storagePath: '/var/lib/quox/files',
      serverFile: '/opt/quoxcore/services/files/server.js'
    },

    troubleshooting: [
      {
        symptom: 'Service not responding',
        checks: [
          'Check container status: docker ps | grep quox-files',
          'Verify port 3102: curl -s http://127.0.0.1:3102/health',
          'Review logs: docker logs quox-files -f'
        ],
        solution: 'Restart the container: docker restart quox-files'
      },
      {
        symptom: 'File upload failures',
        checks: [
          'Check disk space on files-data volume',
          'Verify storage path permissions',
          'Check max upload size configuration'
        ],
        solution: 'Free disk space or fix volume permissions'
      }
    ],

    links: [
      { label: 'Health Check', url: FILES_SERVICE_HEALTH_URL }
    ]
  },

  postgres: {
    name: 'PostgreSQL',
    shortName: 'Postgres',
    containerName: 'postgres',
    restartable: true,
    description: 'Relational database for QuoxFlow',
    longDescription: 'PostgreSQL 16.4 database backing QuoxFlow workflow engine. Stores workflow definitions, execution history, audit trails, and evidence records.',
    port: 5432,
    category: 'data',
    critical: true,
    icon: 'database',
    color: '#336791',

    healthEndpoint: null,
    healthTimeout: 5000,
    thresholds: {
      responseTime: { warning: 100, critical: 500 },
      uptimePercent: { warning: 99.5, critical: 99 }
    },

    dependencies: [],
    dependents: ['quoxflow'],

    docs: {
      configPath: 'Docker environment (POSTGRES_DB, POSTGRES_USER, POSTGRES_PASSWORD)',
      dataPath: 'postgres-data volume (/var/lib/postgresql/data)',
      dockerCompose: '/opt/quoxcore/docker-compose.yml'
    },

    troubleshooting: [
      {
        symptom: 'Service not responding',
        checks: [
          'Check container status: docker ps | grep quox-postgres',
          'Run pg_isready: docker exec quox-postgres pg_isready -U quoxflow',
          'Review logs: docker logs quox-postgres -f'
        ],
        solution: 'Restart the container: docker restart quox-postgres'
      },
      {
        symptom: 'Connection refused from QuoxFlow',
        checks: [
          'Verify DATABASE_URL in quoxflow environment',
          'Check postgres is on the quox-network',
          'Verify credentials match between services'
        ],
        solution: 'Ensure POSTGRES_PASSWORD matches in both service configs'
      }
    ],

    links: [
      { label: 'Docker Logs', url: 'docker logs quox-postgres' }
    ]
  },

  quoxflow: {
    name: 'QuoxFlow',
    shortName: 'QuoxFlow',
    containerName: 'quoxflow',
    restartable: true,
    description: 'Auditable workflow engine',
    longDescription: 'TypeScript workflow engine providing auditable, approval-gated execution of infrastructure operations. Manages workflow definitions, scheduling, evidence collection, and HITL approval chains.',
    port: 3200,
    category: 'core',
    critical: false,
    icon: 'workflow',
    color: '#10b981',

    healthEndpoint: '/health',
    healthTimeout: 5000,
    thresholds: {
      responseTime: { warning: 300, critical: 1000 },
      uptimePercent: { warning: 99, critical: 95 }
    },

    dependencies: ['auth', 'postgres'],
    dependents: ['collector'],

    docs: {
      configPath: '/opt/quoxcore/quoxflow/.env',
      serverFile: '/opt/quoxcore/quoxflow/src/server.ts',
      dockerCompose: '/opt/quoxcore/docker-compose.yml'
    },

    troubleshooting: [
      {
        symptom: 'Service not responding',
        checks: [
          'Check container status: docker ps | grep quox-quoxflow',
          'Verify port 3200: curl -s http://127.0.0.1:3200/health',
          'Review logs: docker logs quox-quoxflow -f'
        ],
        solution: 'Restart the container: docker restart quox-quoxflow'
      },
      {
        symptom: 'Database migration errors',
        checks: [
          'Check PostgreSQL is running and healthy',
          'Verify DATABASE_URL is correct',
          'Review migration logs on startup'
        ],
        solution: 'Ensure postgres is healthy before starting quoxflow'
      }
    ],

    links: [
      { label: 'Health Check', url: '/quoxflow/health' },
      { label: 'API Docs', url: '/docs/quoxflow' }
    ]
  },

  tasks: {
    name: 'Task Service',
    shortName: 'Tasks',
    containerName: 'tasks',
    restartable: true,
    description: 'Background objective execution',
    longDescription: 'Background task service that accepts high-level objectives, decomposes them into agent tasks via LLM, executes them through the collector pipeline, and streams progress. Foundation for autonomous scheduling and agent teams.',
    port: 3104,
    category: 'core',
    critical: false,
    icon: 'target',
    color: '#f97316',

    healthEndpoint: '/health',
    healthTimeout: 5000,
    thresholds: {
      responseTime: { warning: 300, critical: 1000 },
      uptimePercent: { warning: 99, critical: 95 }
    },

    dependencies: ['auth', 'collector'],
    dependents: ['dashboard'],

    docs: {
      configPath: '/opt/quoxcore/services/tasks/.env',
      databasePath: '/var/lib/quox/tasks.db',
      serverFile: '/opt/quoxcore/services/tasks/server.js'
    },

    troubleshooting: [
      {
        symptom: 'Service not responding',
        checks: [
          'Check container status: docker ps | grep quox-tasks',
          'Verify port 3104: curl -s http://127.0.0.1:3104/health',
          'Review logs: docker logs quox-tasks -f'
        ],
        solution: 'Restart the container: docker restart quox-tasks'
      },
      {
        symptom: 'Tasks not executing',
        checks: [
          'Check scheduler status in /health response',
          'Verify collector is reachable from tasks container',
          'Review task_logs table for errors'
        ],
        solution: 'Check COLLECTOR_URL env var and collector health'
      }
    ],

    links: [
      { label: 'Health Check', url: '/tasks/health' }
    ]
  },

  bastion: {
    name: 'QuoxBastion',
    shortName: 'Bastion',
    containerName: null,
    restartable: false,
    description: 'SSH gateway & secure access',
    longDescription: 'QuoxBastion provides secure SSH access to infrastructure hosts through a centralized gateway. It handles SSH key management, session recording, and access control for fleet operations.',
    port: 9850,
    category: 'infrastructure',
    critical: false,
    icon: 'terminal',
    color: '#f59e0b',

    healthEndpoint: '/api/v1/health',
    healthTimeout: 5000,
    thresholds: {
      responseTime: { warning: 200, critical: 1000 },
      uptimePercent: { warning: 99, critical: 95 }
    },

    dependencies: ['quoxagent'],
    dependents: ['collector'],

    docs: {
      configPath: '/etc/quoxbastion/config.yaml',
      logsPath: '/var/log/quoxbastion/',
      binaryPath: '/opt/quoxbastion/bin/quoxbastion',
      systemdService: 'quoxbastion.service'
    },

    troubleshooting: [
      {
        symptom: 'Service not responding',
        checks: [
          'Verify the service is running: systemctl status quoxbastion',
          'Check if port 9850 is open: ss -tlnp | grep 9850',
          'Review logs: journalctl -u quoxbastion -f'
        ],
        solution: 'Restart the service: sudo systemctl restart quoxbastion'
      },
      {
        symptom: 'SSH connections failing',
        checks: [
          'Check SSH key permissions in ~/.ssh/',
          'Verify target host is reachable',
          'Check bastion firewall rules'
        ],
        solution: 'Verify SSH configuration and ensure keys are properly configured'
      }
    ],

    links: [
      { label: 'Health Check', url: '/bastion/api/v1/health' },
      { label: 'Documentation', url: '/docs/bastion' }
    ]
  }
}

/**
 * Get service by key
 */
export function getService(serviceKey) {
  return SERVICE_REGISTRY[serviceKey] || null
}

/**
 * Get all services
 */
export function getAllServices() {
  return Object.entries(SERVICE_REGISTRY).map(([key, service]) => ({
    key,
    ...service
  }))
}

/**
 * Get critical services
 */
export function getCriticalServices() {
  return getAllServices().filter(s => s.critical)
}

/**
 * Get services by category
 */
export function getServicesByCategory(category) {
  return getAllServices().filter(s => s.category === category)
}

/**
 * Get service dependencies (what this service depends on)
 */
export function getServiceDependencies(serviceKey) {
  const service = SERVICE_REGISTRY[serviceKey]
  if (!service) return []

  return service.dependencies.map(depKey => ({
    key: depKey,
    ...SERVICE_REGISTRY[depKey]
  })).filter(Boolean)
}

/**
 * Get service dependents (what depends on this service)
 */
export function getServiceDependents(serviceKey) {
  const service = SERVICE_REGISTRY[serviceKey]
  if (!service) return []

  return service.dependents.map(depKey => ({
    key: depKey,
    ...SERVICE_REGISTRY[depKey]
  })).filter(Boolean)
}

/**
 * Get all categories
 */
export function getCategories() {
  const categories = new Set(Object.values(SERVICE_REGISTRY).map(s => s.category))
  return Array.from(categories)
}

export default SERVICE_REGISTRY
