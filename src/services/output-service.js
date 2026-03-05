const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  bold: '\x1b[1m'
};

function withColor(text, color, useColors) {
  if (!useColors || !color) {
    return text;
  }
  return `${color}${text}${COLORS.reset}`;
}

export class OutputService {
  constructor(options = {}) {
    this.json = Boolean(options.json);
    this.useColors = !this.json && options.colors !== false;
    this.events = [];
  }

  emit(level, message, data = null) {
    const event = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data
    };
    this.events.push(event);

    if (this.json) {
      return;
    }

    const levelColor =
      level === 'error' ? COLORS.red :
      level === 'warn' ? COLORS.yellow :
      level === 'success' ? COLORS.green :
      level === 'title' ? `${COLORS.bold}${COLORS.cyan}` :
      COLORS.reset;

    const prefix =
      level === 'error' ? 'Error: ' :
      level === 'warn' ? 'Warning: ' :
      level === 'success' ? '✓ ' : '';

    console.log(withColor(`${prefix}${message}`, levelColor, this.useColors));
  }

  title(message) {
    this.emit('title', message);
  }

  info(message, data = null) {
    this.emit('info', message, data);
  }

  success(message, data = null) {
    this.emit('success', message, data);
  }

  warn(message, data = null) {
    this.emit('warn', message, data);
  }

  error(message, data = null) {
    this.emit('error', message, data);
  }

  progress(message, data = null) {
    this.emit('info', message, data);
  }

  printSummary(summary) {
    if (this.json) {
      console.log(JSON.stringify({ summary, events: this.events }, null, 2));
      return;
    }

    if (!summary) {
      return;
    }

    console.log('');
    this.title('Summary');
    console.log(`  status: ${summary.status}`);
    if (summary.durationMs !== undefined) {
      console.log(`  durationMs: ${summary.durationMs}`);
    }
    if (summary.nextAction) {
      console.log(`  next: ${summary.nextAction}`);
    }
    if (Array.isArray(summary.artifacts) && summary.artifacts.length > 0) {
      console.log(`  artifacts: ${summary.artifacts.join(', ')}`);
    }
  }
}

export default OutputService;
