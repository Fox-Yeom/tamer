// In-window native avatar (part of libcvimdock, runs inside CVIM).
//
// Neovim's avatar pane can only draw a pixel as half a terminal cell (~8pt), which magnifies the
// sprite ~8×. Here macOS draws the Pokémon's GIF itself — exactly like the desktop overlay — in
// an image view placed over the avatar pane of each CVIM window. Neovim reports where the pane is
// (grid cells) in ~/.cache/cvim/overlay/<id>.json (`rect`), plus one-shot `event`s (attack, cute,
// evolve) and the Claude `state`. Mouse events pass through to Neovim (click = poke, right-click =
// menu), which publishes the resulting event back here.
#import <AppKit/AppKit.h>
#import <QuartzCore/QuartzCore.h>

@interface CVIMPaneView : NSView
@property(strong) NSImageView *img;
@property(strong) NSTextField *fx;
@property(copy) NSString *gif, *state, *type;
@property NSInteger eventSeq;
@property BOOL evolving;
@end

@implementation CVIMPaneView
- (NSView *)hitTest:(NSPoint)p { return nil; }  // clicks go to Neovim
@end

static NSMutableDictionary<NSString *, CVIMPaneView *> *panes;  // "<window number>/<key>" -> view
BOOL cvim_is_our_descendant(pid_t pid);  // cvimoverlay.m

static NSSet *pane_working(void) {
  static NSSet *s;
  if (!s) s = [NSSet setWithArray:@[ @"thinking", @"coding", @"reading", @"searching", @"bash", @"tool", @"agent", @"compact" ]];
  return s;
}

static NSString *pane_type_emoji(NSString *type) {
  NSDictionary *m = @{
    @"electric" : @"⚡", @"fire" : @"🔥", @"water" : @"💧", @"grass" : @"🍃", @"ice" : @"❄️",
    @"psychic" : @"🔮", @"ghost" : @"👻", @"dark" : @"🌑", @"poison" : @"☠️", @"ground" : @"⛰️",
    @"rock" : @"🪨", @"fighting" : @"👊", @"flying" : @"🌪️", @"bug" : @"🐛", @"dragon" : @"🐉",
    @"steel" : @"⚙️", @"fairy" : @"✨",
  };
  return m[type] ?: @"💥";
}

// continuous motion for the Claude state
static void pane_idle_motion(CVIMPaneView *v) {
  CALayer *l = v.img.layer;
  [l removeAnimationForKey:@"motion"];
  BOOL working = [pane_working() containsObject:v.state];
  BOOL waiting = [v.state isEqualToString:@"waiting"];
  CABasicAnimation *a = [CABasicAnimation animationWithKeyPath:@"transform.translation.y"];
  a.fromValue = @0;
  a.toValue = @(waiting ? 14 : working ? ([v.state isEqualToString:@"thinking"] ? 3 : 7) : 2);
  a.duration = waiting ? 0.35 : working ? ([v.state isEqualToString:@"thinking"] ? 0.9 : 0.4) : 1.4;
  a.autoreverses = YES;
  a.repeatCount = HUGE_VALF;
  a.timingFunction = [CAMediaTimingFunction functionWithName:kCAMediaTimingFunctionEaseInEaseOut];
  [l addAnimation:a forKey:@"motion"];
  v.alphaValue = [v.state isEqualToString:@"sleep"] ? 0.55 : 1.0;
}

static void pane_pop_fx(CVIMPaneView *v, NSString *emoji, CGFloat dx, CGFloat dy, double delay) {
  v.fx.stringValue = emoji;
  CAKeyframeAnimation *o = [CAKeyframeAnimation animationWithKeyPath:@"opacity"];
  o.values = @[ @0, @1, @1, @0 ];
  o.keyTimes = @[ @0, @0.15, @0.7, @1 ];
  o.duration = 0.9;
  o.beginTime = CACurrentMediaTime() + delay;
  o.fillMode = kCAFillModeBackwards;
  CABasicAnimation *m = [CABasicAnimation animationWithKeyPath:@"transform.translation"];
  m.fromValue = [NSValue valueWithSize:NSMakeSize(0, 0)];
  m.toValue = [NSValue valueWithSize:NSMakeSize(dx, dy)];
  m.duration = 0.9;
  m.beginTime = o.beginTime;
  [v.fx.layer addAnimation:o forKey:@"fxo"];
  [v.fx.layer addAnimation:m forKey:@"fxm"];
}

static void pane_attack(CVIMPaneView *v) {
  CAKeyframeAnimation *a = [CAKeyframeAnimation animationWithKeyPath:@"transform.translation.x"];
  a.values = @[ @0, @-12, @30, @22, @0 ];
  a.keyTimes = @[ @0, @0.2, @0.4, @0.55, @1 ];
  a.duration = 0.9;
  [v.img.layer addAnimation:a forKey:@"attack"];
  CAKeyframeAnimation *s = [CAKeyframeAnimation animationWithKeyPath:@"transform.scale"];
  s.values = @[ @1, @0.92, @1.12, @1 ];
  s.keyTimes = @[ @0, @0.2, @0.4, @1 ];
  s.duration = 0.9;
  [v.img.layer addAnimation:s forKey:@"punch"];
  pane_pop_fx(v, pane_type_emoji(v.type), 26, 8, 0.32);
}

static void pane_cute(CVIMPaneView *v) {
  CAKeyframeAnimation *a = [CAKeyframeAnimation animationWithKeyPath:@"transform.translation.y"];
  a.values = @[ @0, @18, @0, @12, @0 ];
  a.keyTimes = @[ @0, @0.25, @0.5, @0.75, @1 ];
  a.duration = 0.9;
  [v.img.layer addAnimation:a forKey:@"hop"];
  pane_pop_fx(v, @"💕", 0, 40, 0.05);
}

// classic evolution: white silhouette flickering between the two forms, faster and faster
static void pane_evolve(CVIMPaneView *v, NSString *from, NSString *to) {
  v.evolving = YES;
  NSImage *a = [[NSImage alloc] initWithContentsOfFile:from], *b = [[NSImage alloc] initWithContentsOfFile:to];
  CIFilter *white = [CIFilter filterWithName:@"CIColorMatrix"];
  [white setDefaults];
  [white setValue:[CIVector vectorWithX:0 Y:0 Z:0 W:0] forKey:@"inputRVector"];
  [white setValue:[CIVector vectorWithX:0 Y:0 Z:0 W:0] forKey:@"inputGVector"];
  [white setValue:[CIVector vectorWithX:0 Y:0 Z:0 W:0] forKey:@"inputBVector"];
  [white setValue:[CIVector vectorWithX:1 Y:1 Z:1 W:0] forKey:@"inputBiasVector"];
  v.img.layerUsesCoreImageFilters = YES;
  v.img.layer.filters = @[ white ];
  __block int step = 0;
  __block void (^tick)(void);
  __weak __block void (^weak_tick)(void);
  weak_tick = tick = ^{
    step++;
    v.img.image = (step % 2) ? b : a;
    double gap = MAX(0.06, 0.45 - step * 0.025);
    if (step < 22) {
      void (^next)(void) = weak_tick;
      dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(gap * NSEC_PER_SEC)), dispatch_get_main_queue(), next);
    } else {  // reveal the new form
      v.img.image = b;
      v.img.layer.filters = nil;
      v.gif = to;
      v.evolving = NO;
      pane_pop_fx(v, @"✨", 0, 30, 0);
      pane_cute(v);
    }
  };
  tick();
}

static NSDictionary *presence_for_window(NSWindow *w, NSArray<NSDictionary *> *all) {
  NSString *title = w.title ?: @"";
  NSDictionary *best = nil;
  for (NSDictionary *d in all) {
    NSString *folder = d[@"folder"];
    if (!folder || ![title hasSuffix:[@" " stringByAppendingString:folder]]) continue;
    if (!best || [d[@"opened"] doubleValue] > [best[@"opened"] doubleValue]) best = d;
  }
  return best;
}

static NSArray<NSDictionary *> *read_dir(NSString *sub) {
  NSString *dir = [NSHomeDirectory() stringByAppendingPathComponent:sub];
  NSMutableArray *all = [NSMutableArray array];
  for (NSString *f in [[NSFileManager defaultManager] contentsOfDirectoryAtPath:dir error:nil]) {
    if (![f hasSuffix:@".json"]) continue;
    NSData *data = [NSData dataWithContentsOfFile:[dir stringByAppendingPathComponent:f]];
    NSDictionary *d = data ? [NSJSONSerialization JSONObjectWithData:data options:0 error:nil] : nil;
    if ([d isKindOfClass:[NSDictionary class]] && cvim_is_our_descendant([d[@"pid"] intValue])) [all addObject:d];
  }
  return all;
}

// one avatar (workspace pane, start screen, Pokédex preview) in window `w`
static void update_view(NSWindow *w, NSString *key, NSDictionary *d, NSMutableSet *alive) {
  NSDictionary *rect = [d[@"rect"] isKindOfClass:[NSDictionary class]] ? d[@"rect"] : nil;
  if (!rect || !d[@"gif"]) return;
  NSString *vkey = [NSString stringWithFormat:@"%ld/%@", (long)w.windowNumber, key];
  [alive addObject:vkey];
  CVIMPaneView *v = panes[vkey];
  if (!v || v.superview != w.contentView) {
    [v removeFromSuperview];
    v = [[CVIMPaneView alloc] initWithFrame:NSZeroRect];
    v.wantsLayer = YES;
    v.img = [[NSImageView alloc] initWithFrame:NSZeroRect];
    v.img.animates = YES;
    v.img.imageScaling = NSImageScaleProportionallyUpOrDown;
    v.img.wantsLayer = YES;
    v.img.layer.magnificationFilter = kCAFilterNearest;  // crisp pixels
    [v addSubview:v.img];
    v.fx = [NSTextField labelWithString:@""];
    v.fx.font = [NSFont systemFontOfSize:30];
    v.fx.alignment = NSTextAlignmentCenter;
    v.fx.wantsLayer = YES;
    v.fx.layer.opacity = 0;
    [v addSubview:v.fx];
    [w.contentView addSubview:v positioned:NSWindowAbove relativeTo:nil];
    panes[vkey] = v;
  }
  v.hidden = NO;

  NSDictionary *ev = [d[@"event"] isKindOfClass:[NSDictionary class]] ? d[@"event"] : nil;
  NSInteger seq = [ev[@"seq"] integerValue];
  BOOL evolve_pending = [ev[@"kind"] isEqualToString:@"evolve"] && seq != v.eventSeq;
  BOOL new_gif = !v.evolving && !evolve_pending && ![v.gif isEqualToString:d[@"gif"]];
  if (new_gif) {
    v.gif = d[@"gif"];
    v.img.image = [[NSImage alloc] initWithContentsOfFile:v.gif];
  }

  // grid cells -> points (content view, top-left origin + Neovide padding)
  NSRect b = w.contentView.bounds;
  NSArray *pad = rect[@"pad"];
  double pt = [pad[0] doubleValue], pl = [pad[1] doubleValue], pb = [pad[2] doubleValue], pr = [pad[3] doubleValue];
  double cols = MAX(1, [rect[@"cols"] doubleValue]), lines = MAX(1, [rect[@"lines"] doubleValue]);
  double cw = (b.size.width - pl - pr) / cols, ch = (b.size.height - pt - pb) / lines;
  double x = pl + [rect[@"col"] doubleValue] * cw, top = pt + [rect[@"row"] doubleValue] * ch;
  double width = [rect[@"w"] doubleValue] * cw, height = [rect[@"h"] doubleValue] * ch;
  NSRect frame = NSMakeRect(x, w.contentView.isFlipped ? top : b.size.height - top - height, width, height);
  if (new_gif || !NSEqualRects(v.frame, frame)) {
    v.frame = frame;
    // integer upscale of the GIF that fits, centred (nearest filter keeps it sharp)
    NSSize gs = v.img.image.size.width > 0 ? v.img.image.size : NSMakeSize(96, 96);
    // capped so small sprites don't balloon (a 36px Caterpie would hit 17× in the Pokédex box)
    double cap = [key isEqualToString:@"ws"] ? 3 : 4;
    double s = MIN(cap, floor(MIN(width / gs.width, height / gs.height)));
    if (s < 1) s = MIN(width / gs.width, height / gs.height);
    NSSize is = NSMakeSize(gs.width * s, gs.height * s);
    v.img.frame = NSMakeRect((width - is.width) / 2, (height - is.height) / 2, is.width, is.height);
    v.fx.frame = NSMakeRect(NSMaxX(v.img.frame) - 50, NSMidY(v.img.frame) - 20, 50, 40);
    const char *dbg = getenv("CVIM_DOCK_DEBUG");
    if (dbg) {
      NSString *line = [NSString stringWithFormat:@"pane %@ [%@]: cell=%.2fx%.2f view=%@ img=%@ gif=%@ scale=%.2f\n", w.title, key,
                        cw, ch, NSStringFromRect(frame), NSStringFromRect(v.img.frame), [d[@"gif"] lastPathComponent], s];
      NSString *p = [@(dbg) stringByAppendingString:@".pane"];
      NSFileHandle *fh = [NSFileHandle fileHandleForWritingAtPath:p];
      if (!fh) [line writeToFile:p atomically:NO encoding:NSUTF8StringEncoding error:nil];
      else { [fh seekToEndOfFile]; [fh writeData:[line dataUsingEncoding:NSUTF8StringEncoding]]; [fh closeFile]; }
    }
  }

  NSString *prev = v.state;
  v.type = d[@"type"];
  NSString *state = d[@"state"] ?: @"idle";
  if (![prev isEqualToString:state]) {
    v.state = state;
    pane_idle_motion(v);
    // finished a task: attack
    if (prev && [pane_working() containsObject:prev] && ![pane_working() containsObject:state]) pane_attack(v);
  }
  if (ev && seq != v.eventSeq) {
    v.eventSeq = seq;
    NSString *kind = ev[@"kind"];
    if ([kind isEqualToString:@"attack"]) pane_attack(v);
    else if ([kind isEqualToString:@"cute"]) pane_cute(v);
    else if ([kind isEqualToString:@"evolve"]) pane_evolve(v, ev[@"extra"][@"from"], ev[@"extra"][@"to"]);
  }
}

static void pane_refresh(void) {
  NSArray *workspaces = read_dir(@".cache/cvim/overlay");  // workspace avatar panes
  NSArray *uis = read_dir(@".cache/cvim/ui");              // start screen / Pokédex preview
  NSMutableSet *alive = [NSMutableSet set];
  for (NSWindow *w in NSApp.windows) {
    if (!w.visible || w.tabbingMode == NSWindowTabbingModeDisallowed || !w.contentView) continue;
    NSDictionary *d = presence_for_window(w, workspaces);
    if (d) update_view(w, @"ws", d, alive);
    for (NSDictionary *u in uis) {
      if (![u[@"title"] isEqualToString:w.title]) continue;
      for (NSDictionary *item in u[@"items"]) update_view(w, item[@"key"], item, alive);
    }
  }
  for (NSString *key in panes.allKeys) {
    if (![alive containsObject:key]) panes[key].hidden = YES;
  }
}

void cvim_pane_start(void) {
  panes = [NSMutableDictionary dictionary];
  [NSTimer scheduledTimerWithTimeInterval:0.15 repeats:YES block:^(NSTimer *t) { pane_refresh(); }];
}
