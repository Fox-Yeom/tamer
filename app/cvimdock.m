// libcvimdock: registers CVIM's folders as macOS recent documents, like VS Code does.
//
// The Dock shows an app's recent documents (folder icons at the top of the right-click menu,
// also when the app is closed) only for items the app itself notes via NSDocumentController.
// Neovide never does that, so this library — loaded into CVIM via DYLD_INSERT_LIBRARIES
// (Info.plist LSEnvironment) — watches cvim's list (~/.cache/cvim/recent_dirs, newest first,
// written by nvim/lua/cvim/init.lua) and notes each newly opened folder from inside the app.
// Clicking a recent item goes through application:openFiles: like dropping a folder on the icon.
//
// It also drives macOS native window tabs for Neovim (which can't ask Neovide for a new window):
// nvim posts Darwin notifications with `notifyutil -p <name>`:
//   dev.cvim.tab.new          new window (merged as a tab: NEOVIDE_SYSTEM_NATIVE_TABS)
//   dev.cvim.tab.next / .prev select the next / previous tab
//   dev.cvim.tab.1 … .9       select tab N
// New windows (⌘T, ⌘N, folder tabs) are moved right after the tab you were looking at, instead
// of the end of the tab bar where mergeAllWindows puts them.
#import <AppKit/AppKit.h>
#include <fcntl.h>
#include <notify.h>
#include <stdlib.h>

void cvim_overlay_start(void);  // app/cvimoverlay.m: desktop Pokémon overlay
void cvim_pane_start(void);     // app/cvimpane.m: crisp in-window avatar

static NSString *list_path(void) {
  return [NSHomeDirectory() stringByAppendingPathComponent:@".cache/cvim/recent_dirs"];
}

static NSArray<NSString *> *recent_paths(void) {
  NSString *content = [NSString stringWithContentsOfFile:list_path() encoding:NSUTF8StringEncoding error:nil];
  NSMutableArray *out = [NSMutableArray array];
  for (NSString *line in [content componentsSeparatedByString:@"\n"]) {
    BOOL isDir = NO;
    if (line.length && [[NSFileManager defaultManager] fileExistsAtPath:line isDirectory:&isDir] && isDir) {
      [out addObject:line];
    }
  }
  return out;
}

static void note(NSString *path) {
  [[NSDocumentController sharedDocumentController]
      noteNewRecentDocumentURL:[NSURL fileURLWithPath:path isDirectory:YES]];
}

// register oldest → newest so the newest ends up on top
static void sync_all(void) {
  for (NSString *p in [recent_paths() reverseObjectEnumerator]) note(p);
}

static NSString *last_top = nil;
static dispatch_source_t watcher = nil;

static void on_change(void) {
  NSString *top = recent_paths().firstObject;
  if (top && ![top isEqualToString:last_top]) {
    note(top);
    last_top = top;
  }
}

// nvim rewrites the file (writefile = new inode), so re-arm the watcher after each event
static void watch(void) {
  if (watcher) { dispatch_source_cancel(watcher); watcher = nil; }
  int fd = open(list_path().fileSystemRepresentation, O_EVTONLY);
  if (fd < 0) {  // not created yet: retry later
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 2 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{ watch(); });
    return;
  }
  watcher = dispatch_source_create(DISPATCH_SOURCE_TYPE_VNODE, fd,
                                   DISPATCH_VNODE_WRITE | DISPATCH_VNODE_DELETE | DISPATCH_VNODE_RENAME,
                                   dispatch_get_main_queue());
  dispatch_source_set_event_handler(watcher, ^{
    on_change();
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 5), dispatch_get_main_queue(), ^{ watch(); });
  });
  dispatch_source_set_cancel_handler(watcher, ^{ close(fd); });
  dispatch_resume(watcher);
}

static void on_notify(const char *name, void (^handler)(void)) {
  int token;
  notify_register_dispatch(name, &token, dispatch_get_main_queue(), ^(int t) { handler(); });
}

static NSHashTable<NSWindow *> *known_windows = nil;
static __weak NSWindow *last_key = nil;

static BOOL is_tab_window(NSWindow *w) {
  return [w isKindOfClass:[NSWindow class]] && w.tabbingMode != NSWindowTabbingModeDisallowed;
}

static void debug_log(NSString *what, NSArray *tabs) {
  const char *dbg = getenv("CVIM_DOCK_DEBUG");
  if (!dbg) return;
  NSString *line = [NSString stringWithFormat:@"%@: %@\n", what, [[tabs valueForKey:@"title"] componentsJoinedByString:@" | "]];
  NSFileHandle *fh = [NSFileHandle fileHandleForWritingAtPath:[@(dbg) stringByAppendingString:@".moves"]];
  if (!fh) { [line writeToFile:[@(dbg) stringByAppendingString:@".moves"] atomically:NO encoding:NSUTF8StringEncoding error:nil]; return; }
  [fh seekToEndOfFile]; [fh writeData:[line dataUsingEncoding:NSUTF8StringEncoding]]; [fh closeFile];
}

// Neovide calls mergeAllWindows for every new window, which resets the tab bar to creation
// order (losing earlier moves and the user's drag reordering). So remember the tab order as the
// user last saw it, and after a new window appears re-apply that order with the new tab inserted
// right after the tab it was opened from.
static NSPointerArray *saved_order = nil;  // weak NSWindow refs, tab-bar order

static NSArray<NSWindow *> *current_order(NSWindow *any) {
  return any.tabbedWindows ?: (any ? @[ any ] : @[]);
}

static void save_order(NSWindow *any) {
  saved_order = [NSPointerArray weakObjectsPointerArray];
  for (NSWindow *t in current_order(any)) [saved_order addPointer:(__bridge void *)t];
}

static void apply_order(NSWindowTabGroup *group, NSArray<NSWindow *> *order) {
  [NSAnimationContext runAnimationGroup:^(NSAnimationContext *ctx) {
    ctx.duration = 0;
    for (NSUInteger i = 0; i < order.count; i++) {
      NSWindow *t = order[i];
      if (i < group.windows.count && group.windows[i] == t) continue;
      [group removeWindow:t];
      [group insertWindow:t atIndex:(NSInteger)i];
    }
  }];
}

static void place_after(NSWindow *w, NSWindow *origin) {
  if (!origin || origin == w || ![origin.tabbedWindows containsObject:w]) return;
  NSArray<NSWindow *> *live = origin.tabbedWindows;
  debug_log(@"before", live);
  NSMutableArray<NSWindow *> *order = [NSMutableArray array];
  for (NSWindow *t in saved_order.allObjects) {  // the order the user saw
    if (t != w && [live containsObject:t] && ![order containsObject:t]) [order addObject:t];
  }
  for (NSWindow *t in live) {  // anything we didn't know about, at the end
    if (t != w && ![order containsObject:t]) [order addObject:t];
  }
  NSUInteger at = [order indexOfObject:origin];
  [order insertObject:w atIndex:(at == NSNotFound ? order.count : at + 1)];
  if (![order isEqualToArray:live]) apply_order(origin.tabGroup, order);
  debug_log(@"after", origin.tabbedWindows);
  save_order(origin);
  [w makeKeyAndOrderFront:nil];
}

// windows created by our own tab.new: remember the current tab, then poll for the new window
static void place_next_new_window(void) {
  NSWindow *origin = NSApp.keyWindow ?: NSApp.mainWindow ?: last_key;
  save_order(origin);
  NSSet *before = [NSSet setWithArray:NSApp.windows];
  __block int tries = 0;
  __block void (^poll)(void);
  __weak __block void (^weak_poll)(void);
  weak_poll = poll = ^{
    for (NSWindow *w in NSApp.windows) {
      if (![before containsObject:w] && is_tab_window(w) && [origin.tabbedWindows containsObject:w]) {
        [known_windows addObject:w];
        place_after(w, origin);
        return;
      }
    }
    if (++tries < 80) {  // up to 8s (Neovide spawns Neovim first)
      void (^next)(void) = weak_poll;
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC / 10), dispatch_get_main_queue(), next);
    }
  };
  poll();
}

// other new windows (⌘N, Dock "New Window"): first time one becomes key, place it after the
// previously key tab. Known windows becoming key (tab switch, after a drag) refresh the order.
static void track_new_windows(void) {
  known_windows = [NSHashTable weakObjectsHashTable];
  [[NSNotificationCenter defaultCenter]
      addObserverForName:NSWindowDidBecomeKeyNotification
                  object:nil
                   queue:[NSOperationQueue mainQueue]
              usingBlock:^(NSNotification *n) {
                NSWindow *w = n.object;
                if (!is_tab_window(w)) return;
                if (![known_windows containsObject:w]) {
                  [known_windows addObject:w];
                  place_after(w, last_key);
                } else {
                  save_order(w);
                }
                last_key = w;
              }];
}

static void setup_tab_commands(void) {
  track_new_windows();
  on_notify("dev.cvim.tab.new", ^{
    place_next_new_window();
    id delegate = NSApp.delegate;
    SEL create = NSSelectorFromString(@"neovideCreateWindow:");  // Neovide's "New Window" action
    if ([delegate respondsToSelector:create]) {
      ((void (*)(id, SEL, id))[delegate methodForSelector:create])(delegate, create, nil);
    }
  });
  on_notify("dev.cvim.tab.dump", ^{  // debug: CVIM_DOCK_DEBUG=<file> gets the tab titles in order
    const char *dbg = getenv("CVIM_DOCK_DEBUG");
    if (!dbg) return;
    NSMutableArray *groups = [NSMutableArray array];
    NSMutableSet *seen = [NSMutableSet set];
    for (NSWindow *w in NSApp.windows) {
      if (!w.visible || [seen containsObject:w]) continue;
      NSArray *tabs = w.tabbedWindows ?: @[ w ];
      [seen addObjectsFromArray:tabs];
      [groups addObject:[[tabs valueForKey:@"title"] componentsJoinedByString:@" | "]];
    }
    NSString *line = [NSString stringWithFormat:@"groups=[%@] main=%@\n",
                      [groups componentsJoinedByString:@"] ["], NSApp.mainWindow.title];
    [line writeToFile:@(dbg) atomically:YES encoding:NSUTF8StringEncoding error:nil];
  });
  // tab selection also works while CVIM isn't the active app (no key window): use the last
  // tab seen, and record the selection as the origin for the next new tab
  void (^select)(NSInteger) = ^(NSInteger delta) {
    NSWindow *cur = NSApp.keyWindow ?: NSApp.mainWindow ?: last_key;
    NSArray<NSWindow *> *tabs = current_order(cur);
    if (tabs.count == 0) return;
    NSUInteger i = [tabs indexOfObject:cur];
    NSWindow *w = tabs[(i + tabs.count + delta) % tabs.count];
    [w makeKeyAndOrderFront:nil];
    last_key = w;
  };
  on_notify("dev.cvim.tab.next", ^{ select(1); });
  on_notify("dev.cvim.tab.prev", ^{ select(-1); });
  for (int i = 1; i <= 9; i++) {
    NSString *name = [NSString stringWithFormat:@"dev.cvim.tab.%d", i];
    on_notify(name.UTF8String, ^{
      NSWindow *cur = NSApp.keyWindow ?: NSApp.mainWindow ?: last_key;
      NSArray<NSWindow *> *tabs = current_order(cur);
      NSWindow *w = i == 9 ? tabs.lastObject : (i <= (int)tabs.count ? tabs[i - 1] : nil);  // ⌘9 = last
      [w makeKeyAndOrderFront:nil];
      if (w) last_key = w;
    });
  }
}

__attribute__((constructor)) static void cvimdock_init(void) {
  // keep it out of every child process (nvim, claude, shells)
  unsetenv("DYLD_INSERT_LIBRARIES");
  setup_tab_commands();
  dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
    cvim_overlay_start();
    cvim_pane_start();
    sync_all();
    last_top = recent_paths().firstObject;
    watch();
    const char *dbg = getenv("CVIM_DOCK_DEBUG");
    if (dbg) {
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, NSEC_PER_SEC), dispatch_get_main_queue(), ^{
        NSArray *urls = [[NSDocumentController sharedDocumentController] recentDocumentURLs];
        NSString *s = [NSString stringWithFormat:@"recents=%@\n",
                       [[urls valueForKey:@"lastPathComponent"] componentsJoinedByString:@" | "]];
        [s writeToFile:@(dbg) atomically:YES encoding:NSUTF8StringEncoding error:nil];
      });
    }
  });
}
