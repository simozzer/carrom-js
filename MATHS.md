# The mathematics of carrom-js

This engine does **not** step the world forward frame by frame and check for overlaps.
It treats the board as a sequence of *events* (a disc hits a cushion, two discs touch,
a disc falls into a pocket) and solves **analytically** for the exact time of the next
event, jumps the whole world straight to it, resolves it, and repeats. Between events
every disc follows a known closed-form path, so positions are exact (no time-step error,
no tunnelling) and the simulation cost scales with the number of *collisions*, not with
elapsed time.

Each section below names the file and idea it implements, with the equations as they
appear in the code so anything here can be checked against the source.

> **Credit, honestly.** The architecture and the applied mathematics here are my own,
> derived from first principles: the event-driven scheme, the equations of motion, the
> wall/pocket solves, the piecewise pair decomposition, the impulse collision resolution
> (ported from my earlier Delphi engine), and the aiming/bank-shot geometry. There is
> **one** specialist step I could not derive solo and routed to an AI tool: the
> closed-form **roots of the quartic** for two *simultaneously decelerating* discs
> (§3.2). The later spin/"throw" extension (§4.2–4.3) and the simulation-scored AI
> (§5) were built collaboratively on top of that core. Knowing where that line sits —
> and being straight about it — is the point. See [user-simon] framing.

---

## 1. The motion model — a sliding disc under dry friction

A disc on the board slides under **Coulomb (kinetic) friction**: a constant deceleration
of magnitude $a = \mu g$ acting *opposite to the disc's own velocity*, where $\mu$ is the
friction coefficient and $g$ gravity. Crucially the disc **stops** at zero speed — it
does not reverse (this was a bug in the original Delphi note that I fixed).

Because the friction direction is anti-parallel to velocity, the **direction of travel is
constant** during a free flight — only the speed bleeds off linearly. For initial speed
$v_0 = |\mathbf v_0|$ and unit heading $\hat{\mathbf v}_0$:

$$
\text{speed}(t) = v_0 - \mu g\,t, \qquad
t_{\text{stop}} = \frac{v_0}{\mu g},
$$

$$
\mathbf p(t) = \mathbf p_0 + \hat{\mathbf v}_0\left(v_0 t - \tfrac12 \mu g\, t^2\right),
\quad 0 \le t \le t_{\text{stop}},
$$

and the disc is frozen for $t > t_{\text{stop}}$. This is exactly `positionAfter` /
`stoppingTime` in [body.js](src/body.js), with `DECEL` $= \mu g$.

That a free path is a *straight line* (only re-scaled by friction) is what makes the rest
of the engine analytic: the geometry of every event depends only on the constant heading,
not on the decreasing speed.

---

## 2. The event-driven loop

The loop ([engine.js](src/engine.js)) is:

1. Predict the time of every possible next event and take the **earliest**.
2. Advance *all* discs to that time along their closed-form paths (clamping any that come
   to rest first).
3. Resolve the event (an impulse, a reflection, or a capture).
4. Re-detect only the events involving the one or two discs whose velocity just changed —
   everybody else's predictions are still valid — and repeat.

This is the **event-prediction** scheme for granular/billiard dynamics; I arrived at it
independently and later found it matches the published **Leckie–Greenspan** method. The
incremental "re-detect only what changed" step (step 4) drops the analytic work from
$O(\text{events} \cdot N^2)$ to $O(\text{events} \cdot N)$ for $N$ discs.

---

## 3. Predicting events (all closed-form)

### 3.1 Disc vs cushion — a quadratic

Along a single axis the disc's coordinate is a quadratic in time (constant velocity plus
constant acceleration component). Setting it equal to the cushion line $x = x_{\text{wall}}$
(offset by the radius) gives

$$
x_0 + v_{0x}\,t - \tfrac12 \mu g\,\hat v_{0x}\,t^2 = x_{\text{wall}},
$$

a quadratic; the engine takes the **smallest positive root within the disc's stop time**
([events.js](src/events.js) `detectWall`). Four candidate lines (left/right/top/bottom),
earliest wins. The reflection flips the normal velocity component (§4).

### 3.2 Disc vs disc — a quartic  *(the AI-assisted step)*

Let the two discs have relative position $\Delta\mathbf p(t) = \mathbf p_a(t) - \mathbf p_b(t)$.
While **both** are moving each has a constant acceleration vector, so the relative motion is
a quadratic *vector* in time:

$$
\Delta\mathbf p(t) = \mathbf A + \mathbf B\,t + \mathbf C\,t^2,
\qquad
\mathbf A = \mathbf p_a-\mathbf p_b,\;
\mathbf B = \mathbf v_a-\mathbf v_b,\;
\mathbf C = \tfrac12(\mathbf a_a-\mathbf a_b).
$$

The discs touch when the gap equals the sum of radii $R = r_a + r_b$, i.e.
$|\Delta\mathbf p(t)|^2 = R^2$. Expanding the squared magnitude gives a **quartic** in $t$:

$$
\underbrace{(\mathbf C\!\cdot\!\mathbf C)}_{k_4} t^4
+ \underbrace{2(\mathbf B\!\cdot\!\mathbf C)}_{k_3} t^3
+ \underbrace{(\mathbf B\!\cdot\!\mathbf B + 2\,\mathbf A\!\cdot\!\mathbf C)}_{k_2} t^2
+ \underbrace{2(\mathbf A\!\cdot\!\mathbf B)}_{k_1} t
+ \underbrace{(\mathbf A\!\cdot\!\mathbf A - R^2)}_{k_0} = 0.
$$

These are exactly `k4…k0` in `firstContact` ([events.js](src/events.js)). The engine needs
the **smallest positive real root** in the valid window. Deriving and robustly evaluating
the closed-form roots of this quartic (the Ferrari/Cardano reduction, with the numerical
care to pick the right branch) is the one piece I couldn't do from first principles and
solved with AI assistance; it lives in `firstQuarticRoot` ([roots.js](src/roots.js)).

### 3.3 Disc vs pocket

A pocket is a fixed circle, so this is the same quartic with $\mathbf B,\mathbf C$ from the
single moving disc and $\mathbf A = \mathbf p_0 - \mathbf p_{\text{pocket}}$, $R = $ pocket
radius ([events.js](src/events.js) `detectPocket`). A disc is captured when its centre
enters the pocket radius.

### 3.4 The piecewise trick that keeps it exact

Two discs generally **stop at different times**. While both move, the relative acceleration
$\mathbf C$ is constant and §3.2 holds. Once the sooner one freezes, the relative
acceleration *changes*. The engine handles this by solving over two windows — $[0, T_1]$
with both moving, then $[T_1, T_2]$ with the sooner disc pinned at its rest position — and,
because it re-detects after every event anyway, this two-window split is **exact** rather
than approximate. This decomposition is mine; only the quartic *solver* inside it is the
AI-assisted part.

### 3.5 Broad-phase rejection (a cheap energy bound)

Before doing the expensive quartic solve, a constant-deceleration disc can travel at most
its **stopping distance** before halting:

$$
d_{\text{stop}} = \frac{v_0^2}{2\mu g}
\quad\text{(from } v^2 = v_0^2 - 2\mu g\,d\text{)}.
$$

Two discs can therefore close their centre-gap by at most $d_a + d_b$, so if

$$
|\mathbf A| - R \;>\; \frac{|\mathbf v_a|^2 + |\mathbf v_b|^2}{2\mu g},
$$

contact is impossible and the solve is skipped ([events.js](src/events.js)). The bound is
exact and conservative — it never rejects a real collision.

---

## 4. Resolving a collision (impulses)

### 4.1 Normal impulse with restitution

At contact, the unit normal is $\mathbf n = \widehat{\mathbf p_a - \mathbf p_b}$. With
relative velocity $\mathbf v_{\text{rel}} = \mathbf v_a - \mathbf v_b$ and normal closing
speed $v_n = \mathbf v_{\text{rel}}\!\cdot\!\mathbf n$, the scalar normal impulse for
restitution $e$ is

$$
j_n = -\frac{(1+e)\,v_n}{\tfrac1{m_a} + \tfrac1{m_b}},
\qquad
\mathbf v_a \mathrel{+}= \frac{j_n}{m_a}\mathbf n, \quad
\mathbf v_b \mathrel{-}= \frac{j_n}{m_b}\mathbf n.
$$

This conserves linear momentum and, at $e = 1$, kinetic energy — the standard elastic
result ([collisions.js](src/collisions.js) `resolvePair`, ported from my Delphi
`ResolveElasticCollision`). Cushions reflect the normal component only, scaled by the
cushion restitution, with a tiny threshold zeroed to stop Zeno micro-bouncing.

### 4.2 Tangential "throw" — friction at the contact  *(spin extension)*

Real carrom men *throw*: a spinning or off-square contact drags sideways. Along the tangent
$\mathbf t = \mathbf n^\perp$, the **relative surface velocity** combines the linear slip and
the two spins:

$$
u_t = \mathbf v_{\text{rel}}\!\cdot\!\mathbf t - (\omega_a r_a + \omega_b r_b).
$$

The tangential impulse that would cancel that slip uses an effective inverse mass that
includes rotation. For a **uniform disc** the moment of inertia is $I = \tfrac12 m r^2$, so
$r^2/I = 2/m$ and

$$
\frac1{M_t} = \frac1{m_a} + \frac1{m_b} + \frac{r_a^2}{I_a} + \frac{r_b^2}{I_b}
= 3\!\left(\frac1{m_a} + \frac1{m_b}\right),
\qquad
j_t = -\frac{u_t}{1/M_t}.
$$

Friction can't supply unlimited tangential impulse, so it's **Coulomb-clamped** to
$|j_t| \le \mu_t |j_n|$ (sliding vs sticking). The impulse updates both velocities and, via
torque at the contact point $\mathbf r = \mp r\,\mathbf n$, both spins:
$\Delta\omega = -r\,j_t / I$ ([collisions.js](src/collisions.js)). Because the free path
stays straight, none of this disturbs the analytic event detection — only the velocities at
contact change.

### 4.3 Spin: imparting it, and its decay

An **off-centre flick** offset by $(\text{spin}\cdot r)$ from the striker centre imparts an
angular impulse; dividing the strike moment by the disc inertia gives

$$
\omega = \frac{(\text{spin}\cdot r)\,(m v)}{I}
       = \frac{(\text{spin}\cdot r)\,(m v)}{\tfrac12 m r^2}
       = \frac{2\,\text{spin}\,v}{r}
$$

([engine.js](src/engine.js)). A disc spinning about the vertical axis also loses spin to
board friction. Integrating Coulomb friction over a uniform disc gives a mean friction
radius of $\tfrac23 R$, hence a retarding torque $\tau \approx \tfrac23 \mu m g R$ and an
angular deceleration

$$
\dot\omega = \frac{\tau}{I} = \frac{\tfrac23 \mu m g R}{\tfrac12 m R^2}
           = \frac{4}{3}\,\frac{\mu g}{R},
$$

which is the constant `SPIN_DECEL_K` $= \tfrac43 \mu g$ (per unit radius) decaying $\omega$
each step in [engine.js](src/engine.js).

---

## 5. The aiming geometry (the AI opponent)

### 5.1 Ghost-ball cut shots

To sink target $T$ into pocket $P$, the target must leave along
$\hat{\mathbf d} = \widehat{P - T}$. The striker must therefore strike $T$ at the **ghost
ball** point — the striker-centre position at the moment of contact, one combined radius
back along that line:

$$
\mathbf C = \mathbf T - (r_S + r_T)\,\hat{\mathbf d}.
$$

The shot is then "aim the striker from a legal baseline spot $\mathbf S$ straight through
$\mathbf C$." Every own-man × pocket pair generates one such candidate, ranked by a
geometric quality score (alignment minus a path-length penalty) — [ai.js](src/ai.js)
`candidateShots`.

### 5.2 Single-cushion bank shots

For men sitting behind the striker (no legal forward line), the AI banks off the **far
cushion**. Within each straight leg friction only changes speed, not direction, so the path
is a polyline; only the cushion bends it, flipping the perpendicular velocity and scaling it
by restitution $e$. Folding that bounce in, the leg-1 slope $m_1$ that makes the return leg
pass through the ghost point $C = (c_x, c_y)$ from a striker at $(s, y_0)$, off a far cushion
at striker-centre line $Y_w$, is

$$
m_1 = \frac{(Y_w - y_0) + (Y_w - c_y)/e}{c_x - s},
$$

derived in [ai.js](src/ai.js) `reboundCandidates`. A few baseline positions $s$ are sampled
and the geometrically valid banks kept.

### 5.3 Simulation-scored selection

Geometry only *aims*; to actually choose, the AI runs the **real engine** as a bounded
look-ahead on its top candidates — a small grid of power × angle × spin around each — and
scores the settled outcome ($+$ own coins, $+$ queen, $-$ opponents, a heavy foul penalty
for self-potting). A robustness pass re-scores the leaders over their execution-error box so
a knife-edge pot that self-fouls under a wobble is dropped. This is rollout / robust
optimisation; the engine being analytic and cheap is what makes searching thousands of
candidate shots feasible in a fraction of a second.

---

## Who derived what

| Piece | Source |
|---|---|
| Event-driven prediction scheme (≈ Leckie–Greenspan) | mine, independent |
| Equations of motion under dry friction (§1) | mine |
| Wall / pocket quadratic solves (§3.1, 3.3) | mine |
| Piecewise two-window pair decomposition (§3.4) | mine |
| Broad-phase stopping-distance bound (§3.5) | mine |
| Impulse collision resolution (§4.1) | mine (ported from my Delphi engine) |
| **Closed-form quartic roots for two decelerating discs (§3.2)** | **AI-assisted — the one specialist step** |
| Tangential throw / spin physics (§4.2–4.3) | collaborative extension |
| Ghost-ball & bank-shot geometry, AI search (§5) | mine / collaborative |

[user-simon]: https://github.com/simozzer/carrom-js
