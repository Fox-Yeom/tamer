// Desktop Pokémon overlay (part of libcvimdock, runs inside CVIM).
//
// While CVIM is in the background, a small always-on-top panel shows the Pokémon of the tab you
// were looking at (always) plus every other tab where Claude is working. Like ChatGPT's avatar:
// While CVIM is in the background and Claude is working in any tab, a small always-on-top,
// transparent panel shows each working tab's Pokémon (its Gen-V GIF, animated by AppKit) with a
// speech bubble. When a tab finishes, its Pokémon does an attack motion until you come back.
// Clicking a Pokémon brings CVIM forward on that tab. Hidden while CVIM is active.
//
// Input: ~/.cache/cvim/overlay/<workspace id>.json written by nvim/lua/cvim/pokemon.lua
//   { id, folder, path, state, since, name, gif, pid }
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>
#include <signal.h>
#include <sys/sysctl.h>

// Only Neovims started by this CVIM app count: `cvim` in a terminal or test runs also write
// presence files (same folders, other Pokémon) and must not show up in the overlay.
BOOL cvim_is_our_descendant(pid_t pid) {
  pid_t me = getpid();
  for (int depth = 0; depth < 6 && pid > 1; depth++) {
    struct kinfo_proc info;
    size_t size = sizeof(info);
    int mib[4] = { CTL_KERN, KERN_PROC, KERN_PROC_PID, pid };
    if (sysctl(mib, 4, &info, &size, NULL, 0) != 0 || size == 0) return NO;
    pid = info.kp_eproc.e_ppid;
    if (pid == me) return YES;
  }
  return NO;
}

static NSSet<NSString *> *working_states(void) {
  static NSSet *s;
  if (!s) s = [NSSet setWithArray:@[ @"thinking", @"coding", @"reading", @"searching", @"bash", @"tool", @"agent", @"compact" ]];
  return s;
}

static NSString *bubble_for(NSString *state, BOOL completed) {
  if (completed) return @"✅ 완료!";
  if ([state isEqualToString:@"idle"] || [state isEqualToString:@"done"]) return @"😌 쉬는 중";
  if ([state isEqualToString:@"sleep"]) return @"💤 자는 중";
  NSDictionary *m = @{
    @"thinking" : @"💭 생각 중…", @"coding" : @"⌨️ 코딩 중…", @"reading" : @"📖 읽는 중…",
    @"searching" : @"🔍 검색 중…", @"bash" : @"💻 실행 중…", @"tool" : @"🛠 작업 중…",
    @"agent" : @"🤝 협업 중…", @"compact" : @"🗜 정리 중…", @"waiting" : @"❓ 확인이 필요해요",
    @"error" : @"💥 오류!",
  };
  return m[state] ?: @"…";
}

// ── model ──────────────────────────────────────────────────────────────────
@interface CVIMMon : NSObject
@property NSString *ident, *folder, *state, *name, *gif, *type;
@property BOOL current;  // the tab you were on when CVIM went to the background
@property BOOL completed;
@property double opened;       // workspace open time (most recently opened tab = fallback "current")
@property double toast_until;  // finished while you're in CVIM but on another tab: pop up briefly
@property BOOL entered;        // entrance (slide-in) already played for the current alert
@end
@implementation CVIMMon
@end

static NSMutableDictionary<NSString *, CVIMMon *> *mons;  // id -> mon
static NSPanel *panel;
static NSString *shown_signature;
static NSString *current_folder;  // folder of the key tab when CVIM resigned active

static NSString *type_emoji(NSString *type) {
  NSDictionary *m = @{
    @"electric" : @"⚡", @"fire" : @"🔥", @"water" : @"💧", @"grass" : @"🍃", @"ice" : @"❄️",
    @"psychic" : @"🔮", @"ghost" : @"👻", @"dark" : @"🌑", @"poison" : @"☠️", @"ground" : @"⛰️",
    @"rock" : @"🪨", @"fighting" : @"👊", @"flying" : @"🌪️", @"bug" : @"🐛", @"dragon" : @"🐉",
    @"steel" : @"⚙️", @"fairy" : @"✨",
  };
  return m[type] ?: @"💥";
}

static NSString *overlay_dir(void) {
  return [NSHomeDirectory() stringByAppendingPathComponent:@".cache/cvim/overlay"];
}

static void reload(void) {
  NSFileManager *fm = [NSFileManager defaultManager];
  NSMutableSet *seen = [NSMutableSet set];
  for (NSString *f in [fm contentsOfDirectoryAtPath:overlay_dir() error:nil]) {
    if (![f hasSuffix:@".json"]) continue;
    NSString *path = [overlay_dir() stringByAppendingPathComponent:f];
    NSData *data = [NSData dataWithContentsOfFile:path];
    NSDictionary *d = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if (![d isKindOfClass:[NSDictionary class]]) continue;
    pid_t pid = [d[@"pid"] intValue];
    if (pid > 0 && kill(pid, 0) != 0) {  // stale (nvim gone)
      [fm removeItemAtPath:path error:nil];
      continue;
    }
    if (!cvim_is_our_descendant(pid)) continue;  // another cvim (terminal, tests): not ours
    NSString *ident = d[@"id"];
    if (!ident) continue;
    [seen addObject:ident];
    CVIMMon *m = mons[ident] ?: [CVIMMon new];
    NSString *prev = m.state;
    m.ident = ident;
    m.folder = d[@"folder"];
    m.name = d[@"name"];
    m.gif = d[@"gif"];
    m.type = d[@"type"];
    m.opened = [d[@"opened"] doubleValue];
    m.state = d[@"state"] ?: @"idle";
    BOOL finished = prev && [working_states() containsObject:prev] && ![working_states() containsObject:m.state] &&
                    ![m.state isEqualToString:@"waiting"];
    if (finished && !NSApp.isActive) {
      m.completed = YES;  // finished while you were away: keep it until you come back
    } else if (finished) {
      // you're in CVIM: announce it unless you're already looking at that tab
      NSWindow *key = NSApp.keyWindow;
      BOOL looking = key && [key.title hasSuffix:[@" " stringByAppendingString:m.folder ?: @""]];
      if (!looking) m.toast_until = [NSDate timeIntervalSinceReferenceDate] + 6;
    }
    if ([working_states() containsObject:m.state]) { m.completed = NO; m.toast_until = 0; }
    if (!m.completed && m.toast_until == 0) m.entered = NO;
    mons[ident] = m;
  }
  for (NSString *ident in mons.allKeys) {
    if (![seen containsObject:ident]) [mons removeObjectForKey:ident];
  }
}

static NSArray<CVIMMon *> *visible_mons(void) {
  NSTimeInterval now = [NSDate timeIntervalSinceReferenceDate];
  // newest first, one per folder (the same folder can be open in two tabs / leave a stale file)
  NSArray *sorted = [mons.allValues sortedArrayUsingDescriptors:@[ [NSSortDescriptor sortDescriptorWithKey:@"opened" ascending:NO] ]];
  NSMutableArray *uniq = [NSMutableArray array];
  NSMutableSet *folders = [NSMutableSet set];
  for (CVIMMon *m in sorted) {
    if (!m.folder || [folders containsObject:m.folder]) continue;
    [folders addObject:m.folder];
    [uniq addObject:m];
  }
  NSMutableArray *out = [NSMutableArray array];
  if (NSApp.isActive) {  // in CVIM: only short "done" announcements for other tabs
    for (CVIMMon *m in uniq) if (m.toast_until > now) [out addObject:m];
    return out;
  }
  // the tab you were on (start screen / unknown: the most recently opened one)
  NSString *cur = current_folder ?: ((CVIMMon *)uniq.firstObject).folder;
  for (CVIMMon *m in uniq) {
    m.current = cur && [m.folder isEqualToString:cur];
    if (m.current) {
      [out insertObject:m atIndex:0];  // always, first
    } else if (m.completed || [working_states() containsObject:m.state] || [m.state isEqualToString:@"waiting"] ||
               [m.state isEqualToString:@"error"]) {
      [out addObject:m];
    }
  }
  return out;
}

static BOOL alerting(CVIMMon *m) {
  return m.completed || m.toast_until > [NSDate timeIntervalSinceReferenceDate];
}

// ── views ──────────────────────────────────────────────────────────────────
static const CGFloat CELL_W = 150, CELL_H = 190, MON = 112;

static NSString *const kOverlayAnchor = @"CVIMOverlayAnchor";  // panel's bottom-right corner

@interface CVIMMonView : NSView
@property(copy) NSString *folder;
@end
@implementation CVIMMonView {
  NSPoint _down, _origin;
  BOOL _dragged;
}
- (NSView *)hitTest:(NSPoint)p { return NSPointInRect([self convertPoint:p fromView:self.superview], self.bounds) ? self : nil; }
- (BOOL)acceptsFirstMouse:(NSEvent *)e { return YES; }
- (void)mouseDown:(NSEvent *)e {
  _down = NSEvent.mouseLocation;
  _origin = self.window.frame.origin;
  _dragged = NO;
}
- (void)mouseDragged:(NSEvent *)e {  // drag the whole overlay
  NSPoint p = NSEvent.mouseLocation;
  if (!_dragged && hypot(p.x - _down.x, p.y - _down.y) < 3) return;
  _dragged = YES;
  [self.window setFrameOrigin:NSMakePoint(_origin.x + p.x - _down.x, _origin.y + p.y - _down.y)];
}
- (void)mouseUp:(NSEvent *)e {
  if (_dragged) {  // remember where you put it
    NSRect f = self.window.frame;
    [[NSUserDefaults standardUserDefaults] setObject:@[ @(NSMaxX(f)), @(NSMinY(f)) ] forKey:kOverlayAnchor];
    return;
  }
  // click: bring CVIM forward on this tab
  [NSApp activateIgnoringOtherApps:YES];
  for (NSWindow *w in NSApp.windows) {
    if (w.visible && [w.title hasSuffix:[@" " stringByAppendingString:self.folder]]) { [w makeKeyAndOrderFront:nil]; break; }
  }
}
@end

static NSTextField *label(NSString *text, CGFloat size, NSColor *color) {
  NSTextField *t = [NSTextField labelWithString:text];
  t.font = [NSFont boldSystemFontOfSize:size];
  t.textColor = color;
  t.alignment = NSTextAlignmentCenter;
  return t;
}

static BOOL alerting(CVIMMon *m);

static void animate(CALayer *layer, CVIMMon *m) {
  [layer removeAllAnimations];
  if (alerting(m)) {  // attack: wind up, lunge, recoil — repeated
    CAKeyframeAnimation *a = [CAKeyframeAnimation animationWithKeyPath:@"transform.translation.x"];
    a.values = @[ @0, @-10, @26, @18, @0, @0 ];
    a.keyTimes = @[ @0, @0.15, @0.3, @0.4, @0.6, @1 ];
    a.duration = 1.6;
    a.repeatCount = HUGE_VALF;
    [layer addAnimation:a forKey:@"attack"];
    CAKeyframeAnimation *s = [CAKeyframeAnimation animationWithKeyPath:@"transform.scale"];
    s.values = @[ @1, @0.92, @1.12, @1, @1 ];
    s.keyTimes = @[ @0, @0.15, @0.3, @0.5, @1 ];
    s.duration = 1.6;
    s.repeatCount = HUGE_VALF;
    [layer addAnimation:s forKey:@"punch"];
    return;
  }
  if (![working_states() containsObject:m.state] && ![m.state isEqualToString:@"waiting"]) {  // resting: breathe
    CABasicAnimation *b = [CABasicAnimation animationWithKeyPath:@"transform.translation.y"];
    b.fromValue = @0;
    b.toValue = @2;
    b.duration = 1.4;
    b.autoreverses = YES;
    b.repeatCount = HUGE_VALF;
    b.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
    [layer addAnimation:b forKey:@"breathe"];
    return;
  }
  BOOL waiting = [m.state isEqualToString:@"waiting"];
  CABasicAnimation *bob = [CABasicAnimation animationWithKeyPath:@"transform.translation.y"];
  bob.fromValue = @0;
  bob.toValue = @(waiting ? 14 : ([m.state isEqualToString:@"thinking"] ? 3 : 6));
  bob.duration = waiting ? 0.35 : ([m.state isEqualToString:@"thinking"] ? 0.9 : 0.4);
  bob.autoreverses = YES;
  bob.repeatCount = HUGE_VALF;
  bob.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseOut];
  [layer addAnimation:bob forKey:@"bob"];
}

static void add_impact(NSView *cell, NSString *type) {  // type emoji popping in front of the attack
  NSTextField *boom = label(type_emoji(type), 34, NSColor.whiteColor);
  boom.frame = NSMakeRect(CELL_W - 52, 70, 50, 44);
  boom.wantsLayer = YES;
  [cell addSubview:boom];
  CAKeyframeAnimation *o = [CAKeyframeAnimation animationWithKeyPath:@"opacity"];
  o.values = @[ @0, @0, @1, @1, @0, @0 ];
  o.keyTimes = @[ @0, @0.28, @0.32, @0.5, @0.62, @1 ];
  o.duration = 1.6;
  o.repeatCount = HUGE_VALF;
  [boom.layer addAnimation:o forKey:@"boom"];
}

static NSView *make_cell(CVIMMon *m, CGFloat x) {
  CVIMMonView *cell = [[CVIMMonView alloc] initWithFrame:NSMakeRect(x, 0, CELL_W, CELL_H)];
  cell.folder = m.folder;
  cell.wantsLayer = YES;

  // speech bubble
  NSString *text = m.toast_until > [NSDate timeIntervalSinceReferenceDate] && !m.completed
                     ? [NSString stringWithFormat:@"✅ %@ 완료!", m.folder] : bubble_for(m.state, m.completed);
  NSTextField *bubble = label(text, 12, NSColor.whiteColor);
  bubble.wantsLayer = YES;
  bubble.drawsBackground = NO;
  bubble.layer.backgroundColor = (alerting(m) ? [NSColor colorWithRed:0.24 green:0.62 blue:0.35 alpha:0.95]
                                              : [NSColor colorWithWhite:0.1 alpha:0.88]).CGColor;
  bubble.layer.cornerRadius = 10;
  [bubble sizeToFit];
  CGFloat bw = MIN(CELL_W - 6, bubble.frame.size.width + 18);
  bubble.frame = NSMakeRect((CELL_W - bw) / 2, CELL_H - 30, bw, 24);
  [cell addSubview:bubble];

  // the Pokémon (AppKit animates GIFs)
  NSImageView *img = [[NSImageView alloc] initWithFrame:NSMakeRect((CELL_W - MON) / 2, 34, MON, MON)];
  img.image = [[NSImage alloc] initWithContentsOfFile:m.gif];
  img.animates = YES;
  img.imageScaling = NSImageScaleProportionallyUpOrDown;
  img.wantsLayer = YES;
  img.layer.magnificationFilter = kCAFilterNearest;  // keep pixels crisp
  NSShadow *sh = [NSShadow new];
  sh.shadowColor = [NSColor colorWithWhite:0 alpha:0.5];
  sh.shadowBlurRadius = 6;
  img.shadow = sh;
  [cell addSubview:img];
  animate(img.layer, m);
  if (alerting(m)) {
    add_impact(cell, m.type);
    if (!m.entered) {  // entrance: slide in from the side with a little bounce, then attack
      m.entered = YES;
      CASpringAnimation *in = [CASpringAnimation animationWithKeyPath:@"transform.translation.x"];
      in.fromValue = @(CELL_W + 40);
      in.toValue = @0;
      in.damping = 11;
      in.duration = in.settlingDuration;
      [cell.layer addAnimation:in forKey:@"enter"];
    }
  }

  // name + folder
  NSTextField *name = label([NSString stringWithFormat:@"%@ · %@", m.name ?: @"?", m.folder ?: @""], 11,
                            [NSColor colorWithWhite:1 alpha:0.95]);
  name.wantsLayer = YES;
  name.drawsBackground = NO;
  name.layer.backgroundColor = [NSColor colorWithWhite:0 alpha:0.45].CGColor;
  name.layer.cornerRadius = 7;
  name.lineBreakMode = NSLineBreakByTruncatingMiddle;
  name.frame = NSMakeRect(6, 8, CELL_W - 12, 18);
  [cell addSubview:name];
  return cell;
}

static void ensure_panel(void) {
  if (panel) return;
  panel = [[NSPanel alloc] initWithContentRect:NSMakeRect(0, 0, CELL_W, CELL_H)
                                     styleMask:NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel
                                       backing:NSBackingStoreBuffered
                                         defer:YES];
  panel.level = NSStatusWindowLevel;
  panel.opaque = NO;
  panel.backgroundColor = NSColor.clearColor;
  panel.hasShadow = NO;
  panel.movableByWindowBackground = YES;
  panel.hidesOnDeactivate = NO;
  panel.collectionBehavior = NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary |
                             NSWindowCollectionBehaviorStationary | NSWindowCollectionBehaviorIgnoresCycle;
  panel.tabbingMode = NSWindowTabbingModeDisallowed;  // never join CVIM's tab bar
  panel.releasedWhenClosed = NO;
}

static void refresh(void) {
  reload();
  NSArray<CVIMMon *> *list = visible_mons();
  NSMutableString *sig = [NSMutableString string];
  for (CVIMMon *m in list) [sig appendFormat:@"%@:%@:%d:%d:%d:%@|", m.ident, m.state, m.completed, m.current, alerting(m), m.gif];
  if ([sig isEqualToString:shown_signature ?: @""]) return;
  shown_signature = sig;
  const char *dbg = getenv("CVIM_DOCK_DEBUG");  // debug: log what the overlay shows
  if (dbg) {
    NSString *line = [NSString stringWithFormat:@"%@ active=%d overlay=[%@]\n", [NSDate date], NSApp.isActive, sig];
    NSString *p = [@(dbg) stringByAppendingString:@".overlay"];
    NSFileHandle *fh = [NSFileHandle fileHandleForWritingAtPath:p];
    if (!fh) [line writeToFile:p atomically:NO encoding:NSUTF8StringEncoding error:nil];
    else { [fh seekToEndOfFile]; [fh writeData:[line dataUsingEncoding:NSUTF8StringEncoding]]; [fh closeFile]; }
  }

  if (list.count == 0) {
    [panel orderOut:nil];
    return;
  }
  ensure_panel();
  NSView *content = [[NSView alloc] initWithFrame:NSMakeRect(0, 0, CELL_W * list.count, CELL_H)];
  CGFloat x = 0;
  for (CVIMMon *m in list) {
    [content addSubview:make_cell(m, x)];
    x += CELL_W;
  }
  BOOL first = !panel.visible;
  panel.contentView = content;
  NSRect vis = NSScreen.mainScreen.visibleFrame;
  NSRect f = panel.frame;
  CGFloat w = CELL_W * list.count;
  NSArray *anchor = [[NSUserDefaults standardUserDefaults] arrayForKey:kOverlayAnchor];
  if (first && anchor.count == 2) {  // where you last dragged it
    f = NSMakeRect([anchor[0] doubleValue] - w, [anchor[1] doubleValue], w, CELL_H);
  } else if (first) {  // default: bottom-right corner
    f = NSMakeRect(NSMaxX(vis) - w - 24, NSMinY(vis) + 24, w, CELL_H);
  } else {  // keep the right edge, grow leftwards
    f = NSMakeRect(NSMaxX(f) - w, f.origin.y, w, CELL_H);
  }
  [panel setFrame:f display:YES];
  [panel orderFrontRegardless];
}

void cvim_overlay_start(void) {
  mons = [NSMutableDictionary dictionary];
  [[NSFileManager defaultManager] createDirectoryAtPath:overlay_dir() withIntermediateDirectories:YES attributes:nil error:nil];
  [NSTimer scheduledTimerWithTimeInterval:0.5 repeats:YES block:^(NSTimer *t) { refresh(); }];
  // remember which tab you were on (window title = "<state emoji> <folder>")
  [[NSNotificationCenter defaultCenter] addObserverForName:NSApplicationWillResignActiveNotification
                                                    object:nil
                                                     queue:[NSOperationQueue mainQueue]
                                                usingBlock:^(NSNotification *n) {
                                                  NSString *title = (NSApp.keyWindow ?: NSApp.mainWindow).title;
                                                  NSRange sp = [title rangeOfString:@" "];
                                                  current_folder = sp.location == NSNotFound ? nil : [title substringFromIndex:NSMaxRange(sp)];
                                                }];
  // coming back to CVIM acknowledges completions
  [[NSNotificationCenter defaultCenter] addObserverForName:NSApplicationDidBecomeActiveNotification
                                                    object:nil
                                                     queue:[NSOperationQueue mainQueue]
                                                usingBlock:^(NSNotification *n) {
                                                  for (CVIMMon *m in mons.allValues) m.completed = NO;
                                                  refresh();
                                                }];
}
