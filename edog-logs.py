#!/usr/bin/env python3
"""
EDOG Log Viewer - Beautiful real-time log and telemetry viewer for FabricLiveTable DevMode

Features:
- Real-time log streaming with syntax highlighting
- Telemetry event visualization
- Filtering by log level, activity, component
- Search functionality
- Export capabilities

Usage:
  edog-logs --demo                     Run with simulated data (test the UI)
  edog-logs --watch <directory>        Watch FLT service output directory
  edog-logs --file <path>              Tail a specific log file
  dotnet run 2>&1 | edog-logs          Pipe service output directly
"""

import json
import re
import sys
import os
import time
import threading
import queue
from datetime import datetime
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional, List, Dict
from enum import Enum

try:
    from rich.console import Console
    from rich.live import Live
    from rich.table import Table
    from rich.panel import Panel
    from rich.layout import Layout
    from rich.text import Text
    from rich.style import Style
    from rich.box import ROUNDED, DOUBLE, HEAVY
    from rich.align import Align
    from rich.spinner import Spinner
    from rich import box
    from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn
    from rich.markdown import Markdown
except ImportError:
    print("Installing required packages...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "rich", "-q"])
    from rich.console import Console
    from rich.live import Live
    from rich.table import Table
    from rich.panel import Panel
    from rich.layout import Layout
    from rich.text import Text
    from rich.style import Style
    from rich.box import ROUNDED, DOUBLE, HEAVY
    from rich.align import Align
    from rich.spinner import Spinner
    from rich import box
    from rich.progress import Progress, SpinnerColumn, TextColumn, BarColumn
    from rich.markdown import Markdown

console = Console()

# ============================================================================
# Data Models
# ============================================================================
class LogLevel(Enum):
    DEBUG = "DEBUG"
    INFO = "INFO"
    WARN = "WARN"
    ERROR = "ERROR"
    TELEMETRY = "TELEMETRY"

@dataclass
class LogEntry:
    timestamp: datetime
    level: LogLevel
    component: str
    message: str
    activity_id: Optional[str] = None
    extra: Dict = field(default_factory=dict)

@dataclass 
class TelemetryEvent:
    timestamp: datetime
    activity_name: str
    status: str
    duration_ms: int
    user_id: Optional[str] = None
    correlation_id: Optional[str] = None
    attributes: Dict = field(default_factory=dict)
    result_code: Optional[str] = None

# ============================================================================
# Log Store
# ============================================================================
class LogStore:
    def __init__(self, max_entries: int = 1000):
        self.logs: List[LogEntry] = []
        self.telemetry: List[TelemetryEvent] = []
        self.max_entries = max_entries
        self.lock = threading.Lock()
        self.log_queue = queue.Queue()
        self.telemetry_queue = queue.Queue()
        self.source_info = "Waiting for input..."
        
        # Stats
        self.stats = {
            "total_logs": 0,
            "debug": 0,
            "info": 0,
            "warn": 0,
            "error": 0,
            "telemetry_events": 0,
            "succeeded": 0,
            "failed": 0,
        }
    
    def add_log(self, entry: LogEntry):
        with self.lock:
            self.logs.append(entry)
            if len(self.logs) > self.max_entries:
                self.logs.pop(0)
            self.stats["total_logs"] += 1
            self.stats[entry.level.value.lower()] = self.stats.get(entry.level.value.lower(), 0) + 1
    
    def add_telemetry(self, event: TelemetryEvent):
        with self.lock:
            self.telemetry.append(event)
            if len(self.telemetry) > self.max_entries:
                self.telemetry.pop(0)
            self.stats["telemetry_events"] += 1
            if "succeed" in event.status.lower():
                self.stats["succeeded"] += 1
            elif "fail" in event.status.lower():
                self.stats["failed"] += 1
    
    def get_recent_logs(self, count: int = 50, level_filter: Optional[LogLevel] = None) -> List[LogEntry]:
        with self.lock:
            logs = self.logs[-count:] if not level_filter else [l for l in self.logs if l.level == level_filter][-count:]
            return logs
    
    def get_recent_telemetry(self, count: int = 20) -> List[TelemetryEvent]:
        with self.lock:
            return self.telemetry[-count:]
    
    def clear(self):
        with self.lock:
            self.logs.clear()
            self.telemetry.clear()
            for key in self.stats:
                self.stats[key] = 0

# ============================================================================
# UI Components
# ============================================================================
def create_header(store: LogStore) -> Panel:
    """Create the header panel."""
    header_text = Text()
    header_text.append("🐕 ", style="bold")
    header_text.append("EDOG Log Viewer", style="bold cyan")
    header_text.append("  │  ", style="dim")
    header_text.append(store.source_info, style="italic dim green")
    
    return Panel(
        Align.center(header_text),
        box=HEAVY,
        style="cyan",
        height=3
    )

def create_stats_panel(store: LogStore) -> Panel:
    """Create statistics panel."""
    stats = store.stats
    
    table = Table(show_header=False, box=None, padding=(0, 2))
    table.add_column("Metric", style="dim")
    table.add_column("Value", justify="right")
    
    table.add_row("📊 Total Logs", f"[bold white]{stats['total_logs']}[/]")
    table.add_row("ℹ️  Info", f"[blue]{stats.get('info', 0)}[/]")
    table.add_row("⚠️  Warnings", f"[yellow]{stats.get('warn', 0)}[/]")
    table.add_row("❌ Errors", f"[red]{stats.get('error', 0)}[/]")
    table.add_row("", "")
    table.add_row("📡 Telemetry", f"[bold white]{stats['telemetry_events']}[/]")
    table.add_row("✅ Succeeded", f"[green]{stats['succeeded']}[/]")
    table.add_row("❌ Failed", f"[red]{stats['failed']}[/]")
    
    return Panel(
        table,
        title="[bold]Statistics[/]",
        border_style="green",
        box=ROUNDED
    )

def create_logs_panel(store: LogStore, height: int = 20) -> Panel:
    """Create the logs panel."""
    table = Table(
        show_header=True,
        header_style="bold magenta",
        box=box.SIMPLE,
        expand=True,
        row_styles=["", "dim"]
    )
    
    table.add_column("Time", style="cyan", width=12)
    table.add_column("Level", width=8, justify="center")
    table.add_column("Component", style="blue", width=25)
    table.add_column("Message", style="white", overflow="fold")
    
    logs = store.get_recent_logs(height - 5)
    
    for log in logs:
        level_style = {
            LogLevel.DEBUG: "[dim]DEBUG[/]",
            LogLevel.INFO: "[blue]INFO[/]",
            LogLevel.WARN: "[yellow]WARN[/]",
            LogLevel.ERROR: "[red bold]ERROR[/]",
            LogLevel.TELEMETRY: "[magenta]TELEM[/]",
        }.get(log.level, log.level.value)
        
        # Truncate message if too long
        msg = log.message[:100] + "..." if len(log.message) > 100 else log.message
        
        table.add_row(
            log.timestamp.strftime("%H:%M:%S.%f")[:12],
            level_style,
            log.component[:25],
            msg
        )
    
    if not logs:
        table.add_row("--", "--", "--", "[dim italic]Waiting for logs...[/]")
    
    return Panel(
        table,
        title="[bold]📋 Live Logs[/]",
        border_style="blue",
        box=ROUNDED
    )

def create_telemetry_panel(store: LogStore) -> Panel:
    """Create the telemetry panel."""
    table = Table(
        show_header=True,
        header_style="bold cyan",
        box=box.SIMPLE,
        expand=True
    )
    
    table.add_column("Time", style="dim", width=10)
    table.add_column("Activity", style="cyan", width=20)
    table.add_column("Status", width=12, justify="center")
    table.add_column("Duration", width=10, justify="right")
    table.add_column("Result", width=15)
    
    events = store.get_recent_telemetry(10)
    
    for event in events:
        status_style = "[green]✓ Success[/]" if "succeed" in event.status.lower() else "[red]✗ Failed[/]"
        if "cancel" in event.status.lower():
            status_style = "[yellow]◌ Cancelled[/]"
        
        duration = f"{event.duration_ms:,}ms" if event.duration_ms < 10000 else f"{event.duration_ms/1000:.1f}s"
        
        table.add_row(
            event.timestamp.strftime("%H:%M:%S"),
            event.activity_name[:20],
            status_style,
            duration,
            event.result_code or "-"
        )
    
    if not events:
        table.add_row("--", "--", "--", "--", "[dim italic]No telemetry yet[/]")
    
    return Panel(
        table,
        title="[bold]📡 Telemetry Events[/]",
        border_style="magenta",
        box=ROUNDED
    )

def create_activity_panel(store: LogStore) -> Panel:
    """Create activity breakdown panel."""
    events = store.get_recent_telemetry(100)
    
    # Group by activity
    activities = {}
    for event in events:
        name = event.activity_name
        if name not in activities:
            activities[name] = {"count": 0, "success": 0, "failed": 0, "total_ms": 0}
        activities[name]["count"] += 1
        activities[name]["total_ms"] += event.duration_ms
        if "succeed" in event.status.lower():
            activities[name]["success"] += 1
        else:
            activities[name]["failed"] += 1
    
    table = Table(show_header=True, header_style="bold", box=box.SIMPLE)
    table.add_column("Activity", style="cyan")
    table.add_column("Count", justify="right")
    table.add_column("Success", justify="right", style="green")
    table.add_column("Failed", justify="right", style="red")
    table.add_column("Avg Time", justify="right")
    
    for name, data in sorted(activities.items(), key=lambda x: x[1]["count"], reverse=True)[:8]:
        avg_ms = data["total_ms"] // data["count"] if data["count"] > 0 else 0
        table.add_row(
            name[:18],
            str(data["count"]),
            str(data["success"]),
            str(data["failed"]),
            f"{avg_ms}ms"
        )
    
    if not activities:
        table.add_row("[dim]No data[/]", "-", "-", "-", "-")
    
    return Panel(
        table,
        title="[bold]📊 Activity Breakdown[/]",
        border_style="yellow",
        box=ROUNDED
    )

def create_layout(store: LogStore) -> Layout:
    """Create the main layout."""
    layout = Layout()
    
    layout.split_column(
        Layout(name="header", size=3),
        Layout(name="body"),
        Layout(name="footer", size=3)
    )
    
    layout["body"].split_row(
        Layout(name="main", ratio=3),
        Layout(name="sidebar", ratio=1)
    )
    
    layout["main"].split_column(
        Layout(name="logs", ratio=2),
        Layout(name="telemetry", ratio=1)
    )
    
    layout["sidebar"].split_column(
        Layout(name="stats"),
        Layout(name="activities")
    )
    
    # Populate layout
    layout["header"].update(create_header(store))
    layout["logs"].update(create_logs_panel(store))
    layout["telemetry"].update(create_telemetry_panel(store))
    layout["stats"].update(create_stats_panel(store))
    layout["activities"].update(create_activity_panel(store))
    
    footer_text = Text()
    footer_text.append(" Press ", style="dim")
    footer_text.append("Ctrl+C", style="bold yellow")
    footer_text.append(" to quit", style="dim")
    layout["footer"].update(Panel(Align.center(footer_text), box=box.SIMPLE))
    
    return layout

# ============================================================================
# Log Parser
# ============================================================================
class LogParser:
    """Parse log lines from FLT service output."""
    
    # Patterns for different log formats
    
    # EDOG DevMode Tracer format: [HH:mm:ss.fff] [LEVEL] message
    EDOG_TRACER_PATTERN = re.compile(
        r'\[(?P<timestamp>\d{2}:\d{2}:\d{2}\.\d{3})\]\s*'
        r'\[(?P<level>DEBUG|INFO|WARN|WARNING|ERROR)\s*\]\s*'
        r'(?P<message>.*)',
        re.IGNORECASE
    )
    
    TRACER_PATTERN = re.compile(
        r'\[(?P<timestamp>[\d\-T:\.]+)\]\s*'
        r'(?P<level>DEBUG|INFO|WARN|WARNING|ERROR)\s*'
        r'(?:\[(?P<component>[^\]]+)\])?\s*'
        r'(?P<message>.*)',
        re.IGNORECASE
    )
    
    SIMPLE_PATTERN = re.compile(
        r'(?P<level>DEBUG|INFO|WARN|WARNING|ERROR)[,:]?\s*'
        r'(?P<timestamp>[\d/\-\s:\.]+)[,]?\s*'
        r'(?:TID:(?P<tid>\d+)[,]?)?\s*'
        r'(?:File:(?P<file>[^,]+)[,]?)?\s*'
        r'(?:Method:(?P<method>[^,]+)[,]?)?\s*'
        r'(?:Line:(?P<line>\d+)[,]?)?\s*'
        r'(?P<message>.*)',
        re.IGNORECASE
    )
    
    # Updated pattern to match: [TELEMETRY] Activity: X | Status: Y | Result: Z | Duration: Wms | CorrelationId: ...
    TELEMETRY_PATTERN = re.compile(
        r'\[TELEMETRY\]\s*Activity:\s*(?P<activity>[\w\-]+)\s*\|\s*'
        r'Status:\s*(?P<status>\w+)\s*\|\s*'
        r'Result:\s*(?P<result>[^\|]+)\s*\|\s*'
        r'Duration:\s*(?P<duration>\d+)ms\s*\|\s*'
        r'CorrelationId:\s*(?P<correlation_id>[\w\-]+)',
        re.IGNORECASE
    )
    
    # FLT-specific patterns
    FLT_PATTERNS = [
        re.compile(r'LiveTable[:\s-](?P<message>.*)', re.IGNORECASE),
        re.compile(r'DAG\s*(execution|Exec)', re.IGNORECASE),
        re.compile(r'GTS[:\s-](?P<message>.*)', re.IGNORECASE),
        re.compile(r'Node\s*(execution|submit)', re.IGNORECASE),
        re.compile(r'Catalog[:\s-]', re.IGNORECASE),
        re.compile(r'OneLake[:\s-]', re.IGNORECASE),
        re.compile(r'Token[:\s-]', re.IGNORECASE),
        re.compile(r'MWC[:\s-]', re.IGNORECASE),
        re.compile(r'Workload[:\s-]', re.IGNORECASE),
    ]
    
    MONITORED_SCOPE_PATTERN = re.compile(
        r'LiveTable[- ](?P<scope>[A-Za-z\-]+)',
        re.IGNORECASE
    )
    
    @classmethod
    def parse_line(cls, line: str) -> Optional[LogEntry]:
        """Parse a log line into a LogEntry."""
        line = line.strip()
        if not line:
            return None
        
        # Skip empty or very short lines
        if len(line) < 5:
            return None
        
        # Try EDOG tracer pattern first (highest priority)
        match = cls.EDOG_TRACER_PATTERN.match(line)
        if match:
            return LogEntry(
                timestamp=datetime.now(),
                level=LogLevel[match.group("level").upper().replace("WARNING", "WARN")],
                component="FLT",
                message=match.group("message")
            )
        
        # Try tracer pattern
        match = cls.TRACER_PATTERN.match(line)
        if match:
            return LogEntry(
                timestamp=datetime.now(),
                level=LogLevel[match.group("level").upper().replace("WARNING", "WARN")],
                component=match.group("component") or "FLT",
                message=match.group("message")
            )
        
        # Try simple pattern (ConsoleLogger format)
        match = cls.SIMPLE_PATTERN.match(line)
        if match:
            component = match.group("file") or "FLT"
            if match.group("method"):
                component = f"{component}.{match.group('method')}"
            return LogEntry(
                timestamp=datetime.now(),
                level=LogLevel[match.group("level").upper().replace("WARNING", "WARN")],
                component=component[:30],
                message=match.group("message")
            )
        
        # Check for FLT-specific patterns
        for pattern in cls.FLT_PATTERNS:
            if pattern.search(line):
                level = LogLevel.INFO
                if "error" in line.lower() or "exception" in line.lower() or "fail" in line.lower():
                    level = LogLevel.ERROR
                elif "warn" in line.lower():
                    level = LogLevel.WARN
                
                # Extract component from MonitoredScope if present
                scope_match = cls.MONITORED_SCOPE_PATTERN.search(line)
                component = scope_match.group("scope") if scope_match else "FLT"
                
                return LogEntry(
                    timestamp=datetime.now(),
                    level=level,
                    component=component,
                    message=line[:200]
                )
        
        # Check for standard .NET/ASP.NET Core log patterns
        if any(keyword in line for keyword in ["Microsoft.", "System.", "Hosting", "Application", "Request", "dbug:", "info:", "warn:", "fail:", "crit:"]):
            level = LogLevel.INFO
            if "fail:" in line.lower() or "crit:" in line.lower() or "error" in line.lower():
                level = LogLevel.ERROR
            elif "warn:" in line.lower():
                level = LogLevel.WARN
            elif "dbug:" in line.lower():
                level = LogLevel.DEBUG
            
            # Extract component
            component = "ASP.NET"
            if "Microsoft." in line:
                comp_match = re.search(r'Microsoft\.(\w+)', line)
                if comp_match:
                    component = comp_match.group(1)
            
            return LogEntry(
                timestamp=datetime.now(),
                level=level,
                component=component,
                message=line[:200]
            )
        
        # Generic fallback for any substantial line
        if len(line) > 10:
            level = LogLevel.INFO
            if "error" in line.lower() or "exception" in line.lower() or "fail" in line.lower():
                level = LogLevel.ERROR
            elif "warn" in line.lower():
                level = LogLevel.WARN
            elif "debug" in line.lower():
                level = LogLevel.DEBUG
            
            return LogEntry(
                timestamp=datetime.now(),
                level=level,
                component="System",
                message=line[:200]
            )
        
        return None
    
    @classmethod
    def parse_telemetry(cls, line: str) -> Optional[TelemetryEvent]:
        """Parse a telemetry line into a TelemetryEvent."""
        match = cls.TELEMETRY_PATTERN.search(line)
        if match:
            return TelemetryEvent(
                timestamp=datetime.now(),
                activity_name=match.group("activity"),
                status=match.group("status"),
                duration_ms=int(match.group("duration")),
                result_code=match.group("result").strip(),
                correlation_id=match.group("correlation_id")
            )
        return None

# ============================================================================
# Log Watchers
# ============================================================================
class StdinWatcher(threading.Thread):
    """Watch stdin for log lines."""
    
    def __init__(self, store: LogStore):
        super().__init__(daemon=True)
        self.store = store
        self.running = True
        self.store.source_info = "Reading from stdin (pipe your service output)"
    
    def run(self):
        while self.running:
            try:
                line = sys.stdin.readline()
                if not line:
                    time.sleep(0.1)
                    continue
                
                # Try to parse as telemetry first
                telemetry = LogParser.parse_telemetry(line)
                if telemetry:
                    self.store.add_telemetry(telemetry)
                    continue
                
                # Parse as log
                log = LogParser.parse_line(line)
                if log:
                    self.store.add_log(log)
            except Exception:
                pass
    
    def stop(self):
        self.running = False


class FileWatcher(threading.Thread):
    """Watch a file for new lines (tail -f style)."""
    
    def __init__(self, store: LogStore, file_path: str):
        super().__init__(daemon=True)
        self.store = store
        self.file_path = Path(file_path)
        self.running = True
        self.store.source_info = f"Watching: {self.file_path.name}"
    
    def run(self):
        if not self.file_path.exists():
            self.store.add_log(LogEntry(
                timestamp=datetime.now(),
                level=LogLevel.ERROR,
                component="FileWatcher",
                message=f"File not found: {self.file_path}"
            ))
            return
        
        with open(self.file_path, 'r', encoding='utf-8', errors='ignore') as f:
            # Go to end of file
            f.seek(0, 2)
            
            while self.running:
                line = f.readline()
                if not line:
                    time.sleep(0.1)
                    continue
                
                telemetry = LogParser.parse_telemetry(line)
                if telemetry:
                    self.store.add_telemetry(telemetry)
                    continue
                
                log = LogParser.parse_line(line)
                if log:
                    self.store.add_log(log)
    
    def stop(self):
        self.running = False


class DirectoryWatcher(threading.Thread):
    """Watch a directory for log files and tail them."""
    
    def __init__(self, store: LogStore, directory: str):
        super().__init__(daemon=True)
        self.store = store
        self.directory = Path(directory)
        self.running = True
        self.file_watchers = []
        self.store.source_info = f"Watching: {self.directory}"
    
    def run(self):
        if not self.directory.exists():
            self.store.add_log(LogEntry(
                timestamp=datetime.now(),
                level=LogLevel.ERROR,
                component="DirWatcher",
                message=f"Directory not found: {self.directory}"
            ))
            return
        
        # Find log files
        log_patterns = ["*.log", "*.txt", "*output*"]
        log_files = []
        for pattern in log_patterns:
            log_files.extend(self.directory.glob(pattern))
        
        if not log_files:
            self.store.add_log(LogEntry(
                timestamp=datetime.now(),
                level=LogLevel.WARN,
                component="DirWatcher",
                message=f"No log files found in {self.directory}"
            ))
        
        for log_file in log_files[:5]:  # Watch max 5 files
            watcher = FileWatcher(self.store, str(log_file))
            watcher.start()
            self.file_watchers.append(watcher)
        
        while self.running:
            time.sleep(1)
    
    def stop(self):
        self.running = False
        for watcher in self.file_watchers:
            watcher.stop()


# ============================================================================
# Demo Data Generator
# ============================================================================
class DemoDataGenerator(threading.Thread):
    """Generate demo data for testing the UI."""
    
    ACTIVITIES = ["GetLatestDag", "RunDag", "NodeExecution", "CatalogFetch", "OneLakeRead", "TokenRefresh"]
    COMPONENTS = ["LiveTableController", "DagExecutionHandler", "GTSBasedSparkClient", "CatalogHandler", "NodeExecutor"]
    MESSAGES = [
        "Starting DAG execution for workspace {ws}",
        "Fetching catalog metadata from OneLake",
        "Submitting node {node} to GTS",
        "Node execution completed successfully",
        "Token refresh triggered, expires in 45m",
        "Received PUT response from GTS",
        "DAG execution completed: {nodes} nodes processed",
        "Loading MLV execution definition",
        "Checking node dependencies",
        "Parallel node limit: 25",
    ]
    
    def __init__(self, store: LogStore):
        super().__init__(daemon=True)
        self.store = store
        self.running = True
        self.store.source_info = "Demo Mode (simulated data)"
    
    def run(self):
        import random
        
        while self.running:
            # Generate a log entry
            if random.random() < 0.7:
                level = random.choices(
                    [LogLevel.DEBUG, LogLevel.INFO, LogLevel.WARN, LogLevel.ERROR],
                    weights=[10, 60, 20, 10]
                )[0]
                
                msg = random.choice(self.MESSAGES)
                msg = msg.format(
                    ws=f"ws-{random.randint(1000,9999)}",
                    node=f"node-{random.randint(1,20)}",
                    nodes=random.randint(5, 50)
                )
                
                self.store.add_log(LogEntry(
                    timestamp=datetime.now(),
                    level=level,
                    component=random.choice(self.COMPONENTS),
                    message=msg
                ))
            
            # Generate a telemetry event
            if random.random() < 0.3:
                status = random.choices(
                    ["Succeeded", "Failed", "SucceededWithErrors"],
                    weights=[80, 15, 5]
                )[0]
                
                self.store.add_telemetry(TelemetryEvent(
                    timestamp=datetime.now(),
                    activity_name=random.choice(self.ACTIVITIES),
                    status=status,
                    duration_ms=random.randint(50, 5000),
                    result_code="0" if "Succeeded" in status else f"FLT_{random.randint(1000,9999)}"
                ))
            
            time.sleep(random.uniform(0.2, 1.5))
    
    def stop(self):
        self.running = False

# ============================================================================
# Main Application
# ============================================================================
def run_viewer(data_source):
    """Run the log viewer with the given data source."""
    store = data_source.store
    data_source.start()
    
    try:
        with Live(create_layout(store), refresh_per_second=4, screen=True) as live:
            while True:
                live.update(create_layout(store))
                time.sleep(0.25)
    except KeyboardInterrupt:
        pass
    finally:
        data_source.stop()
        console.print("\n[green]✓[/] Log viewer closed")

def show_splash():
    """Show splash screen."""
    console.clear()
    
    splash = """
[bold cyan]
    ███████╗██████╗  ██████╗  ██████╗     ██╗      ██████╗  ██████╗ ███████╗
    ██╔════╝██╔══██╗██╔═══██╗██╔════╝     ██║     ██╔═══██╗██╔════╝ ██╔════╝
    █████╗  ██║  ██║██║   ██║██║  ███╗    ██║     ██║   ██║██║  ███╗███████╗
    ██╔══╝  ██║  ██║██║   ██║██║   ██║    ██║     ██║   ██║██║   ██║╚════██║
    ███████╗██████╔╝╚██████╔╝╚██████╔╝    ███████╗╚██████╔╝╚██████╔╝███████║
    ╚══════╝╚═════╝  ╚═════╝  ╚═════╝     ╚══════╝ ╚═════╝  ╚═════╝ ╚══════╝
[/]
[dim]              Real-time Log & Telemetry Viewer for FabricLiveTable[/]
"""
    console.print(splash)
    console.print()

def main():
    import argparse
    
    parser = argparse.ArgumentParser(
        description="EDOG Log Viewer - Real-time log and telemetry viewer for FLT DevMode",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  edog-logs --demo                    Run with simulated data (test the UI)
  edog-logs --file service.log        Tail a specific log file
  edog-logs --watch ./logs            Watch a directory for log files
  
  # Pipe service output from FLT repo:
  cd C:\\path\\to\\workload-fabriclivetable\\Service\\Microsoft.LiveTable.Service.EntryPoint
  dotnet run 2>&1 | edog-logs
        """
    )
    parser.add_argument("--demo", action="store_true", help="Run with demo/simulated data")
    parser.add_argument("--file", "-f", type=str, help="Tail a specific log file")
    parser.add_argument("--watch", "-w", type=str, help="Watch a directory for log files")
    parser.add_argument("--no-splash", action="store_true", help="Skip splash screen")
    
    args = parser.parse_args()
    
    if not args.no_splash:
        show_splash()
        time.sleep(0.5)
    
    store = LogStore()
    
    # Choose data source
    if args.demo:
        console.print("[yellow]Running in demo mode with simulated data[/]")
        data_source = DemoDataGenerator(store)
    elif args.file:
        console.print(f"[cyan]Tailing file: {args.file}[/]")
        data_source = FileWatcher(store, args.file)
    elif args.watch:
        console.print(f"[cyan]Watching directory: {args.watch}[/]")
        data_source = DirectoryWatcher(store, args.watch)
    else:
        # Check if stdin has data (piped input)
        if not sys.stdin.isatty():
            console.print("[cyan]Reading from piped input...[/]")
            data_source = StdinWatcher(store)
        else:
            console.print("[yellow]No input source specified. Running in demo mode.[/]")
            console.print("[dim]Use --help to see usage options[/]\n")
            time.sleep(1)
            data_source = DemoDataGenerator(store)
    
    time.sleep(0.5)
    run_viewer(data_source)

if __name__ == "__main__":
    main()

