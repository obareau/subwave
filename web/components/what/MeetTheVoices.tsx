import Figure from './Figure';
import EditorialReveal from '../landing/EditorialReveal';
import ObservatoryEmbed from '../observatory/ObservatoryEmbed';

// The DJ's habits printed as one small hour of the booth log — the same
// timestamp + kind-chip vocabulary as the dash screenshot above the block.
// The graveyard times are deliberate: the copy's own "3am host" is on the
// desk for the picks and links, and the hour changes hands at 04:00.
const HABITS = [
  {
    time: '03:04',
    kind: 'pick',
    tag: 'Pick',
    title: 'Picks the next track.',
    body:
      'The DJ reads the time, the weather, the season, festivals on the calendar, what just played, and any listener requests, then asks an LLM what should come next and pulls a real song from the library.',
  },
  {
    time: '03:07',
    kind: 'link',
    tag: 'Link',
    title: 'Talks between songs.',
    body:
      'Intros, time checks, weather reads, and station idents are all written live in the DJ’s voice, then spoken aloud and ducked under the music. Nothing is pre-recorded.',
  },
  {
    time: '04:00',
    kind: 'handoff',
    tag: 'Handoff',
    title: 'Changes with the hour.',
    body:
      'A scheduled show can hand the hour to a different persona, signed off live on air, and seat up to three guest co-hosts who trade banter with the host. The 3am host is not the 8am host.',
  },
] as const;

export default function MeetTheVoices() {
  return (
    <EditorialReveal className="bs-section">
      <p className="bs-eyebrow">PART TWO · THE DJ</p>
      <h2>An LLM with a library and a microphone.</h2>
      <p className="text-muted">
        The voice between the tracks is not air talent. It is a persona (a name,
        a soul, a voice engine, a talk frequency) driven by a language model.
      </p>

      <Figure
        src="/screenshots/admin-personas.webp"
        alt="Admin — Personas"
        label="Admin — Personas"
        width={2360}
        height={1640}
        caption="The persona roster: up to twenty-four DJ identities, each with its own voice and habits."
      />

      <div className="mt-4">
        <p className="bs-airlog-cap">The booth log · one small hour on air</p>
        <div>
          {HABITS.map((h) => (
            <article key={h.title} className="bs-airlog-entry">
              <div className="bs-airlog-when">
                {h.time}
                <span className="bs-airlog-tag" data-kind={h.kind}>
                  {h.tag}
                </span>
              </div>
              <div className="bs-airlog-body">
                <h3>{h.title}</h3>
                <p>{h.body}</p>
              </div>
            </article>
          ))}
        </div>
      </div>

      <div className="mt-8">
        <h3 className="m-0 mb-[10px] text-[clamp(22px,2.6vw,30px)] leading-[1.15] font-extrabold tracking-[-0.02em]">
          See the shape of the music.
        </h3>
        <p className="m-0 mb-7 max-w-[64ch] text-[14px] leading-[1.6] text-muted">
          Every track the DJ knows, mapped by how it sounds — clustered by genre,
          lit by energy. This is the library it reaches into when it chooses what
          comes next. Hover a star to read it; click one to see what it would mix
          into. (A sample library below; your own catalogue draws its own.)
        </p>
        <ObservatoryEmbed />
      </div>

      <p className="mt-8 max-w-[64ch] text-[14px] leading-[1.6] text-muted">
        And both the model doing the thinking and the voice doing the talking are
        the operator’s to choose — that is what comes next.
      </p>
    </EditorialReveal>
  );
}
