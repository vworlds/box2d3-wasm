import { strict as assert } from 'assert';
import Box2DFactory from '../dist/entry.mjs'

const box2d = await Box2DFactory();

// C Interface
(() => {
  const {
      b2DefaultWorldDef,
      b2CreateWorld,
      b2World_Step,
      b2MakeBox,
      b2DefaultBodyDef,
      b2DefaultShapeDef,
      b2CreatePolygonShape,
      b2CreateBody,
      b2Body_GetPosition,
      b2Body_GetRotation,
      b2Rot_GetAngle,
      b2BodyType,
      b2Vec2,
  } = box2d;

  const B2_SECRET_COOKIE = 1152023;
  const worldDef = b2DefaultWorldDef();
  assert(worldDef.internalValue === B2_SECRET_COOKIE);
  const worldId = b2CreateWorld(worldDef);
  console.log('hello', worldId);

  const sideLengthMetres = 1;
  const square = b2MakeBox(sideLengthMetres, sideLengthMetres);
  console.log('square', square)

  const zero = new b2Vec2(0, 0);

  const bd = new b2DefaultBodyDef();
  bd.type = b2BodyType.b2_dynamicBody;
  bd.position = zero;

  const bodyId = b2CreateBody(worldId, bd);

  const shapeDef = b2DefaultShapeDef();
  shapeDef.density = 1.0;
  shapeDef.material.friction = 0.3;

  const shapeId = b2CreatePolygonShape(bodyId, shapeDef, square);

  console.log('shapeId', shapeId)

  const timeStep = 1.0 / 60.0;
  const subStepCount = 4;

  console.log('bodyId', bodyId)

  for (let i = 0; i < 90; ++i)
  {
    b2World_Step(worldId, timeStep, subStepCount);
    const position = b2Body_GetPosition(bodyId);
    const rotation = b2Body_GetRotation(bodyId);
    console.log(position.x, position.y, b2Rot_GetAngle(rotation));
  }
})();

