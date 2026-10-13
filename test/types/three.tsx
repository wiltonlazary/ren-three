// ren-three as a TypeScript consumer sees it: three.js elements, $animate, a root.
// three.js ships no declarations; ren-three types its namespace loosely.
declare const THREE: Record<string, any>;
import { Root, $signal, $read, $dispose } from 'ren-core';
import { $three, render, $animate, Renderer, Tick } from 'ren-three';

const three: Renderer = $three(THREE, { width: 320, height: 200, background: '#101010', camera: { fov: 40, position: [0, 2, 6] } });
const root = Root({ id: 'stage', renderer: three, children: () => <Spinner /> });
const angle = $signal(root, 0);
const Spinner = () => {
  $animate((frame: Tick) => void (frame.delta + frame.time));
  return (
    <mesh rotation-y={() => $read(angle)} onClick={(event: any) => void event.object}>
      <boxGeometry params={[1, 1, 1]} />
      <meshStandardMaterial color="#3a86ff" />
    </mesh>
  );
};
const stop: () => void = render(() => <group />, $three(THREE, { schedule: false }));
const drawn: boolean = three.frame(16);
const hits: any[] = three.pick(10, 10);
void stop, drawn, hits;
$dispose(root);
// @ts-expect-error schedule is 'frame' or false
$three(THREE, { schedule: 'idle' });
