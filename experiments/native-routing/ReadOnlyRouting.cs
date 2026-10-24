using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Automation.Text;

// Product-owned read-only UIA experiment. No input/click/send implementations.
internal static class ReadOnlyRouting {
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 32768, RecursionLimit = 12 };
  static int pid; static long ticks; static string exe, nonce; static IntPtr hwnd;
  static string observationPhase = "validate";
  static string Limited(string value, int max) { if (value == null) return ""; if (value.Length > max) throw new Exception("value-limit"); return value; }
  static void Keys(Dictionary<string, object> obj, params string[] allowed) {
    foreach (string key in obj.Keys) if (Array.IndexOf(allowed, key) < 0) throw new Exception("invalid-schema");
    foreach (string key in allowed) if (!obj.ContainsKey(key)) throw new Exception("invalid-schema");
  }
  static AutomationElement Validate() {
    using (Process process = Process.GetProcessById(pid)) {
      if (process.HasExited || process.StartTime.ToUniversalTime().Ticks != ticks ||
          !String.Equals(Path.GetFullPath(process.MainModule.FileName), exe, StringComparison.OrdinalIgnoreCase) ||
          process.SessionId != Process.GetCurrentProcess().SessionId || !IsWindow(hwnd)) throw new Exception("session-mismatch");
    }
    uint owner; GetWindowThreadProcessId(hwnd, out owner); if (owner != pid) throw new Exception("window-mismatch");
    AutomationElement root = AutomationElement.FromHandle(hwnd);
    if (root == null || root.Current.ProcessId != pid) throw new Exception("window-unavailable");
    return root;
  }
  static object Witness() { return new { pid, startTicks = ticks.ToString(), hwnd = hwnd.ToInt64().ToString(), executable = Path.GetFileName(exe) }; }
  static bool Within(AutomationElement element, AutomationElement root) {
    for (int depth = 0; element != null && depth < 64; depth++, element = TreeWalker.ControlViewWalker.GetParent(element))
      if (Automation.Compare(element, root)) return true;
    return false;
  }
  static AutomationElement ExactPath(AutomationElement root, object value) {
    object[] steps = value as object[];
    if (steps == null || steps.Length < 1 || steps.Length > 8) throw new Exception("invalid-selector");
    AutomationElement selected = root;
    foreach (object raw in steps) {
      Dictionary<string, object> step = raw as Dictionary<string, object>; if (step == null) throw new Exception("invalid-selector");
      Keys(step, "automationId", "controlType");
      string id = step["automationId"] as string, type = step["controlType"] as string;
      if (String.IsNullOrEmpty(id) || id.Length > 128 || type != "Text" && type != "Pane" && type != "Group" && type != "Document" && type != "Edit") throw new Exception("invalid-selector");
      ControlType control = type == "Text" ? ControlType.Text : type == "Pane" ? ControlType.Pane : type == "Group" ? ControlType.Group : type == "Edit" ? ControlType.Edit : ControlType.Document;
      AutomationElementCollection matches = selected.FindAll(TreeScope.Children, new AndCondition(new PropertyCondition(AutomationElement.AutomationIdProperty, id), new PropertyCondition(AutomationElement.ControlTypeProperty, control)));
      if (matches.Count != 1) throw new Exception("header-not-unique");
      selected = matches[0];
    }
    return selected;
  }
  static object Observe(Dictionary<string, object> request) {
    observationPhase = "validate";
    string op = request["op"] as string;
    if (op == "observe-header" || op == "observe-selection" && request.ContainsKey("path")) Keys(request, "v", "id", "op", "nonce", "path");
    else Keys(request, "v", "id", "op", "nonce");
    if (!(request["v"] is int) || (int)request["v"] != 1 || request["nonce"] as string != nonce) throw new Exception("invalid-request");
    AutomationElement root = Validate();
    if (op == "probe") return new { witness = Witness(), windowTitle = Limited(root.Current.Name, 1024), provenance = "window-property-only" };
    if (op == "observe-selection") {
      observationPhase = "focus";
      bool exact = request.ContainsKey("path");
      AutomationElement focused = exact ? ExactPath(root, request["path"]) : AutomationElement.FocusedElement;
      observationPhase = "focus-owner";
      if (focused == null || focused.Current.ProcessId != pid) throw new Exception("focus-outside-target");
      observationPhase = "focus-ancestry";
      if (!Within(focused, root)) throw new Exception("focus-outside-target");
      if (exact) {
        observationPhase = "foreground-root";
        if (GetAncestor(GetForegroundWindow(), 2) != GetAncestor(hwnd, 2)) throw new Exception("focus-outside-target");
        observationPhase = "selected-control-focus";
        if (!focused.Current.HasKeyboardFocus) throw new Exception("focus-outside-target");
      }
      observationPhase = "text-pattern";
      object value; if (!focused.TryGetCurrentPattern(TextPattern.Pattern, out value)) throw new Exception("selection-unsupported");
      observationPhase = "text-selection";
      TextPatternRange[] ranges = ((TextPattern)value).GetSelection();
      if (ranges.Length != 1) throw new Exception("single-selection-required");
      string text = ranges[0].GetText(16001);
      if (String.IsNullOrWhiteSpace(text)) throw new Exception("empty-selection");
      Limited(text, 16000); Validate();
      return new { witness = Witness(), text, provenance = "ui-selected-text", platformMessageId = (string)null };
    }
    if (op == "observe-header") {
      AutomationElement selected = ExactPath(root, request["path"]);
      string header = Limited(selected.Current.Name, 1024); Validate();
      return new { witness = Witness(), header, provenance = "explicit-ui-header", platformChatId = (string)null };
    }
    throw new Exception("unsupported-operation");
  }
  static string ReadLineBounded() {
    StringBuilder text = new StringBuilder(); int next;
    while ((next = Console.In.Read()) != -1 && next != '\n') {
      if (text.Length >= 32768) throw new Exception("request-limit");
      if (next != '\r') text.Append((char)next);
    }
    return next == -1 && text.Length == 0 ? null : text.ToString();
  }
  [MTAThread] static int Main(string[] args) {
    try {
      // GUI-subsystem helpers must use inherited pipes directly. Changing
      // Console.InputEncoding can require a console that intentionally does
      // not exist, and must not create/activate a console to read selected UI.
      Console.SetIn(new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false), false));
      Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
      Console.SetError(new StreamWriter(Console.OpenStandardError(), new UTF8Encoding(false)) { AutoFlush = true });
      if (args.Length != 5 || !Int32.TryParse(args[0], out pid) || !Int64.TryParse(args[1], out ticks)) return 2;
      exe = Path.GetFullPath(args[2]); long handle; if (!Int64.TryParse(args[3], out handle)) return 2; hwnd = new IntPtr(handle); nonce = args[4];
      if (nonce.Length != 48) return 2;
      Validate();
      Console.WriteLine(Json.Serialize(new { v = 1, type = "ready", nonce, witness = Witness() }));
      for (;;) {
        string line = ReadLineBounded(); if (line == null) return 0;
        string id = null;
        string phase = "decode";
        try {
          Dictionary<string, object> request = Json.DeserializeObject(line) as Dictionary<string, object>;
          if (request == null || !(request["id"] is string)) throw new Exception();
          id = Limited((string)request["id"], 64);
          phase = "observe";
          object result = Observe(request);
          Console.WriteLine(Json.Serialize(new { v = 1, id, nonce, ok = true, result }));
        } catch (Exception error) {
          string[] safe = { "selection-unsupported", "focus-outside-target", "single-selection-required", "empty-selection", "header-not-unique", "invalid-schema", "invalid-request", "session-mismatch", "window-mismatch", "window-unavailable", "value-limit" };
          Console.WriteLine(Json.Serialize(new { v = 1, id, nonce, ok = false, phase = observationPhase, error = Array.IndexOf(safe, error.Message) >= 0 ? error.Message : phase == "decode" ? "request-decode-failed" : "observation-provider-unavailable-" + observationPhase }));
        }
      }
    } catch { Console.Error.WriteLine("Read-only target unavailable"); return 2; }
  }
}
