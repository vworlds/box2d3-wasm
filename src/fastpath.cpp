// Fast path: plain C exports for the per-step data paths (prefix b2x_).
//
// Every function here calls the same public Box2D C function(s) the embind bindings call, with
// the same arguments. It only removes the binding layer: ids cross as packed integers, floats as
// f32, results land in caller-owned wasm memory. Nothing here changes what Box2D computes.
//
// Ids:
//   world                     w = index1 | generation << 16
//   body / shape / chain      (index1, rev) with rev = world0 | generation << 16
//
// Struct layouts are published as JSON by b2x_GetLayout(), built from sizeof/offsetof below, so
// JavaScript never hardcodes an offset.
#include <box2d/box2d.h>
#include <box2d/math_functions.h>
#include <emscripten.h>

#include <cstddef>
#include <cstdint>
#include <cstdio>

#define B2X_API extern "C" EMSCRIPTEN_KEEPALIVE

// Bumped whenever an exported signature or record layout changes.
#define B2X_VERSION 1

namespace {

inline b2WorldId WorldId(int32_t w)
{
	return b2WorldId{ (uint16_t)( (uint32_t)w & 0xffffu ), (uint16_t)( (uint32_t)w >> 16 ) };
}

inline b2BodyId BodyId(int32_t index1, int32_t rev)
{
	return b2BodyId{ index1, (uint16_t)( (uint32_t)rev & 0xffffu ), (uint16_t)( (uint32_t)rev >> 16 ) };
}

inline b2ShapeId ShapeId(int32_t index1, int32_t rev)
{
	return b2ShapeId{ index1, (uint16_t)( (uint32_t)rev & 0xffffu ), (uint16_t)( (uint32_t)rev >> 16 ) };
}

inline uint32_t Rev(uint16_t world0, uint16_t generation)
{
	return (uint32_t)world0 | ( (uint32_t)generation << 16 );
}

} // namespace

extern "C" {

// One exported move: everything vecs's pose-out reads for a moved body.
typedef struct b2xMove
{
	int32_t bodyIndex; // bodyId.index1
	uint32_t rev;	   // bodyId.world0 | bodyId.generation << 16
	uint32_t userData; // low 32 bits of the body's user data
	uint32_t flags;	   // B2X_MOVE_* bits below
	float x, y;		   // transform.p
	float c, s;		   // transform.q
	float angle;	   // b2Rot_GetAngle(transform.q), i.e. b2Atan2(s, c)
	float vx, vy;	   // b2Body_GetLinearVelocity (when B2X_EXPORT_VELOCITY)
	float w;		   // b2Body_GetAngularVelocity (when B2X_EXPORT_VELOCITY)
} b2xMove;

// b2x_Body_GetPose output.
typedef struct b2xPose
{
	float x, y;	 // b2Body_GetPosition
	float c, s;	 // b2Body_GetRotation
	float angle; // b2Rot_GetAngle of that rotation
} b2xPose;

// b2x_Body_GetMotion output: the values vecs's physics(world).bodyMotion reads.
typedef struct b2xMotion
{
	int32_t awake;		  // b2Body_IsAwake (1 or 0)
	float vx, vy;		  // b2Body_GetLinearVelocity
	float w;			  // b2Body_GetAngularVelocity
	float linearDamping;  // b2Body_GetLinearDamping
	float angularDamping; // b2Body_GetAngularDamping
	float localCenterX;	  // b2Body_GetLocalCenterOfMass
	float localCenterY;
	float mass;			  // b2Body_GetMass
	float gravityScale;	  // b2Body_GetGravityScale
} b2xMotion;

typedef struct b2xSpan
{
	uint32_t ptr;
	int32_t count;
} b2xSpan;

typedef struct b2xContactSpans
{
	b2xSpan begin;
	b2xSpan end;
	b2xSpan hit;
} b2xContactSpans;

typedef struct b2xSensorSpans
{
	b2xSpan begin;
	b2xSpan end;
} b2xSensorSpans;

} // extern "C"

// Export flags.
#define B2X_EXPORT_VELOCITY 1
#define B2X_EXPORT_DYNAMIC_ONLY 2

// b2xMove.flags bits.
#define B2X_MOVE_FELL_ASLEEP 1u
#define B2X_MOVE_TYPE_SHIFT 1u // 2 bits: b2BodyType (static 0, kinematic 1, dynamic 2)
#define B2X_MOVE_VALID 8u	   // the body id was valid when exported

// ---------------------------------------------------------------------------------------------
// Layout

namespace {

char g_layout[8192];
int g_layoutLength = 0;
bool g_layoutFirstStruct = true;
bool g_layoutFirstField = true;

void Append( const char* text )
{
	g_layoutLength += snprintf( g_layout + g_layoutLength, sizeof( g_layout ) - g_layoutLength, "%s", text );
}

void BeginStruct( const char* name, size_t size )
{
	char buffer[128];
	snprintf( buffer, sizeof( buffer ), "%s\"%s\":{\"size\":%d", g_layoutFirstStruct ? "" : "},", name, (int)size );
	Append( buffer );
	g_layoutFirstStruct = false;
}

void Field( const char* name, size_t offset )
{
	char buffer[128];
	snprintf( buffer, sizeof( buffer ), ",\"%s\":%d", name, (int)offset );
	Append( buffer );
}

void Constant( const char* name, int value )
{
	char buffer[128];
	snprintf( buffer, sizeof( buffer ), "%s\"%s\":%d", g_layoutFirstField ? "" : ",", name, value );
	Append( buffer );
	g_layoutFirstField = false;
}

} // namespace

// 4-byte aligned field: addressable as (ptr + offset) >> 2 in Int32/Uint32/Float32 views.
#define B2X_FIELD( T, name, member )                                                                                         \
	static_assert( offsetof( T, member ) % 4 == 0, #T "." #member " must be 4-byte aligned" );                               \
	Field( #name, offsetof( T, member ) )
// Byte-addressed field (uint16/bool members): read with Uint16Array / Uint8Array views.
#define B2X_BYTE_FIELD( T, name, member ) Field( #name, offsetof( T, member ) )
#define B2X_STRUCT( name, T )                                                                                                \
	static_assert( sizeof( T ) % 4 == 0, #T " size must be a multiple of 4" );                                               \
	BeginStruct( #name, sizeof( T ) )

#define B2X_SHAPE_ID_FIELDS( T, prefix, member )                                                                             \
	B2X_FIELD( T, prefix, member.index1 );                                                                                   \
	B2X_BYTE_FIELD( T, prefix##World0, member.world0 );                                                                      \
	B2X_BYTE_FIELD( T, prefix##Generation, member.generation )

static void BuildLayout()
{
	Append( "{\"constants\":{" );
	Constant( "version", B2X_VERSION );
	Constant( "exportVelocity", B2X_EXPORT_VELOCITY );
	Constant( "exportDynamicOnly", B2X_EXPORT_DYNAMIC_ONLY );
	Constant( "moveFellAsleep", B2X_MOVE_FELL_ASLEEP );
	Constant( "moveTypeShift", B2X_MOVE_TYPE_SHIFT );
	Constant( "moveValid", B2X_MOVE_VALID );
	Append( "}," );

	B2X_STRUCT( move, b2xMove );
	B2X_FIELD( b2xMove, bodyIndex, bodyIndex );
	B2X_FIELD( b2xMove, rev, rev );
	B2X_FIELD( b2xMove, userData, userData );
	B2X_FIELD( b2xMove, flags, flags );
	B2X_FIELD( b2xMove, x, x );
	B2X_FIELD( b2xMove, y, y );
	B2X_FIELD( b2xMove, c, c );
	B2X_FIELD( b2xMove, s, s );
	B2X_FIELD( b2xMove, angle, angle );
	B2X_FIELD( b2xMove, vx, vx );
	B2X_FIELD( b2xMove, vy, vy );
	B2X_FIELD( b2xMove, w, w );

	B2X_STRUCT( pose, b2xPose );
	B2X_FIELD( b2xPose, x, x );
	B2X_FIELD( b2xPose, y, y );
	B2X_FIELD( b2xPose, c, c );
	B2X_FIELD( b2xPose, s, s );
	B2X_FIELD( b2xPose, angle, angle );

	B2X_STRUCT( motion, b2xMotion );
	B2X_FIELD( b2xMotion, awake, awake );
	B2X_FIELD( b2xMotion, vx, vx );
	B2X_FIELD( b2xMotion, vy, vy );
	B2X_FIELD( b2xMotion, w, w );
	B2X_FIELD( b2xMotion, linearDamping, linearDamping );
	B2X_FIELD( b2xMotion, angularDamping, angularDamping );
	B2X_FIELD( b2xMotion, localCenterX, localCenterX );
	B2X_FIELD( b2xMotion, localCenterY, localCenterY );
	B2X_FIELD( b2xMotion, mass, mass );
	B2X_FIELD( b2xMotion, gravityScale, gravityScale );

	B2X_STRUCT( span, b2xSpan );
	B2X_FIELD( b2xSpan, ptr, ptr );
	B2X_FIELD( b2xSpan, count, count );

	B2X_STRUCT( contactSpans, b2xContactSpans );
	B2X_FIELD( b2xContactSpans, beginPtr, begin.ptr );
	B2X_FIELD( b2xContactSpans, beginCount, begin.count );
	B2X_FIELD( b2xContactSpans, endPtr, end.ptr );
	B2X_FIELD( b2xContactSpans, endCount, end.count );
	B2X_FIELD( b2xContactSpans, hitPtr, hit.ptr );
	B2X_FIELD( b2xContactSpans, hitCount, hit.count );

	B2X_STRUCT( sensorSpans, b2xSensorSpans );
	B2X_FIELD( b2xSensorSpans, beginPtr, begin.ptr );
	B2X_FIELD( b2xSensorSpans, beginCount, begin.count );
	B2X_FIELD( b2xSensorSpans, endPtr, end.ptr );
	B2X_FIELD( b2xSensorSpans, endCount, end.count );

	B2X_STRUCT( moveEvent, b2BodyMoveEvent );
	B2X_FIELD( b2BodyMoveEvent, userData, userData );
	B2X_FIELD( b2BodyMoveEvent, x, transform.p.x );
	B2X_FIELD( b2BodyMoveEvent, y, transform.p.y );
	B2X_FIELD( b2BodyMoveEvent, c, transform.q.c );
	B2X_FIELD( b2BodyMoveEvent, s, transform.q.s );
	B2X_SHAPE_ID_FIELDS( b2BodyMoveEvent, body, bodyId );
	B2X_BYTE_FIELD( b2BodyMoveEvent, fellAsleep, fellAsleep );

	B2X_STRUCT( contactBegin, b2ContactBeginTouchEvent );
	B2X_SHAPE_ID_FIELDS( b2ContactBeginTouchEvent, shapeA, shapeIdA );
	B2X_SHAPE_ID_FIELDS( b2ContactBeginTouchEvent, shapeB, shapeIdB );
	B2X_FIELD( b2ContactBeginTouchEvent, contact, contactId.index1 );

	B2X_STRUCT( contactEnd, b2ContactEndTouchEvent );
	B2X_SHAPE_ID_FIELDS( b2ContactEndTouchEvent, shapeA, shapeIdA );
	B2X_SHAPE_ID_FIELDS( b2ContactEndTouchEvent, shapeB, shapeIdB );
	B2X_FIELD( b2ContactEndTouchEvent, contact, contactId.index1 );

	B2X_STRUCT( contactHit, b2ContactHitEvent );
	B2X_SHAPE_ID_FIELDS( b2ContactHitEvent, shapeA, shapeIdA );
	B2X_SHAPE_ID_FIELDS( b2ContactHitEvent, shapeB, shapeIdB );
	B2X_FIELD( b2ContactHitEvent, pointX, point.x );
	B2X_FIELD( b2ContactHitEvent, pointY, point.y );
	B2X_FIELD( b2ContactHitEvent, normalX, normal.x );
	B2X_FIELD( b2ContactHitEvent, normalY, normal.y );
	B2X_FIELD( b2ContactHitEvent, approachSpeed, approachSpeed );

	B2X_STRUCT( sensorBegin, b2SensorBeginTouchEvent );
	B2X_SHAPE_ID_FIELDS( b2SensorBeginTouchEvent, sensorShape, sensorShapeId );
	B2X_SHAPE_ID_FIELDS( b2SensorBeginTouchEvent, visitorShape, visitorShapeId );

	B2X_STRUCT( sensorEnd, b2SensorEndTouchEvent );
	B2X_SHAPE_ID_FIELDS( b2SensorEndTouchEvent, sensorShape, sensorShapeId );
	B2X_SHAPE_ID_FIELDS( b2SensorEndTouchEvent, visitorShape, visitorShapeId );

	Append( "}}" );
}

// JSON describing every struct the fast path exposes: {"constants":{...},"move":{"size":48,
// "bodyIndex":0,...},...}. Offsets and sizes are bytes. Built once; never allocates.
B2X_API const char* b2x_GetLayout( void )
{
	if ( g_layoutLength == 0 )
	{
		BuildLayout();
	}
	return g_layout;
}

B2X_API int b2x_GetVersion( void )
{
	return B2X_VERSION;
}

// ---------------------------------------------------------------------------------------------
// Profile timers (patches/box2d/0001-runtime-switch-for-profile-timers.patch)

extern "C" void b2SetProfileTimers( bool enabled );
extern "C" bool b2GetProfileTimers( void );

// Box2D reads a clock (a JavaScript call) for every timed section of every step, only to fill
// b2World_GetProfile. Off removes those calls; results are unaffected; the profile reads zeros.
B2X_API void b2x_SetProfileTimers( int32_t enabled )
{
	b2SetProfileTimers( enabled != 0 );
}

B2X_API int32_t b2x_GetProfileTimers( void )
{
	return b2GetProfileTimers() ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// World step and moves

B2X_API void b2x_World_Step( int32_t world, float timeStep, int32_t subStepCount )
{
	b2World_Step( WorldId( world ), timeStep, subStepCount );
}

B2X_API int b2x_World_GetMoveCount( int32_t world )
{
	return b2World_GetBodyEvents( WorldId( world ) ).moveCount;
}

// Writes one record per move event, in Box2D's event order, into `out` (at most `capacity`
// records). Returns the number of records the export produced; when that exceeds `capacity`,
// grow the buffer and call again (move events stay valid until the next step).
B2X_API int b2x_World_ExportMoves( int32_t world, b2xMove* out, int32_t capacity, int32_t flags )
{
	b2BodyEvents events = b2World_GetBodyEvents( WorldId( world ) );
	const bool velocity = ( flags & B2X_EXPORT_VELOCITY ) != 0;
	const bool dynamicOnly = ( flags & B2X_EXPORT_DYNAMIC_ONLY ) != 0;
	int count = 0;
	for ( int i = 0; i < events.moveCount; ++i )
	{
		const b2BodyMoveEvent& event = events.moveEvents[i];
		const bool valid = b2Body_IsValid( event.bodyId );
		const b2BodyType type = valid ? b2Body_GetType( event.bodyId ) : b2_staticBody;
		if ( dynamicOnly && type != b2_dynamicBody )
		{
			continue;
		}
		if ( count < capacity )
		{
			b2xMove& move = out[count];
			move.bodyIndex = event.bodyId.index1;
			move.rev = Rev( event.bodyId.world0, event.bodyId.generation );
			move.userData = (uint32_t)(uintptr_t)event.userData;
			move.flags = ( event.fellAsleep ? B2X_MOVE_FELL_ASLEEP : 0u ) | ( (uint32_t)type << B2X_MOVE_TYPE_SHIFT ) |
						 ( valid ? B2X_MOVE_VALID : 0u );
			move.x = event.transform.p.x;
			move.y = event.transform.p.y;
			move.c = event.transform.q.c;
			move.s = event.transform.q.s;
			move.angle = b2Rot_GetAngle( event.transform.q );
			if ( velocity && valid )
			{
				b2Vec2 v = b2Body_GetLinearVelocity( event.bodyId );
				move.vx = v.x;
				move.vy = v.y;
				move.w = b2Body_GetAngularVelocity( event.bodyId );
			}
			else
			{
				move.vx = 0.0f;
				move.vy = 0.0f;
				move.w = 0.0f;
			}
		}
		++count;
	}
	return count;
}

// b2x_World_Step followed by b2x_World_ExportMoves, in one crossing.
B2X_API int b2x_World_StepAndExportMoves( int32_t world, float timeStep, int32_t subStepCount, b2xMove* out,
										   int32_t capacity, int32_t flags )
{
	b2World_Step( WorldId( world ), timeStep, subStepCount );
	return b2x_World_ExportMoves( world, out, capacity, flags );
}

// Zero-copy view of Box2D's own b2BodyMoveEvent array (layout "moveEvent").
B2X_API void b2x_World_GetMoveEventSpan( int32_t world, b2xSpan* out )
{
	b2BodyEvents events = b2World_GetBodyEvents( WorldId( world ) );
	out->ptr = (uint32_t)(uintptr_t)events.moveEvents;
	out->count = events.moveCount;
}

// Zero-copy views of Box2D's contact event arrays (layouts "contactBegin", "contactEnd",
// "contactHit"). Valid until the next step or world mutation.
B2X_API void b2x_World_GetContactSpans( int32_t world, b2xContactSpans* out )
{
	b2ContactEvents events = b2World_GetContactEvents( WorldId( world ) );
	out->begin = b2xSpan{ (uint32_t)(uintptr_t)events.beginEvents, events.beginCount };
	out->end = b2xSpan{ (uint32_t)(uintptr_t)events.endEvents, events.endCount };
	out->hit = b2xSpan{ (uint32_t)(uintptr_t)events.hitEvents, events.hitCount };
}

// Zero-copy views of Box2D's sensor event arrays (layouts "sensorBegin", "sensorEnd").
B2X_API void b2x_World_GetSensorSpans( int32_t world, b2xSensorSpans* out )
{
	b2SensorEvents events = b2World_GetSensorEvents( WorldId( world ) );
	out->begin = b2xSpan{ (uint32_t)(uintptr_t)events.beginEvents, events.beginCount };
	out->end = b2xSpan{ (uint32_t)(uintptr_t)events.endEvents, events.endCount };
}

// ---------------------------------------------------------------------------------------------
// Integer user data (stored in Box2D's void* userData, carried by every move event)

B2X_API void b2x_Body_SetUserData( int32_t index1, int32_t rev, uint32_t value )
{
	b2Body_SetUserData( BodyId( index1, rev ), (void*)(uintptr_t)value );
}

B2X_API uint32_t b2x_Body_GetUserData( int32_t index1, int32_t rev )
{
	return (uint32_t)(uintptr_t)b2Body_GetUserData( BodyId( index1, rev ) );
}

B2X_API void b2x_Shape_SetUserData( int32_t index1, int32_t rev, uint32_t value )
{
	b2Shape_SetUserData( ShapeId( index1, rev ), (void*)(uintptr_t)value );
}

B2X_API uint32_t b2x_Shape_GetUserData( int32_t index1, int32_t rev )
{
	return (uint32_t)(uintptr_t)b2Shape_GetUserData( ShapeId( index1, rev ) );
}

// ---------------------------------------------------------------------------------------------
// Composites: one crossing for a call sequence vecs makes today, in the same order. The rest of
// the b2Body_* API is generated in fastpath_body.gen.cpp (scripts/gen_fastpath.py).

// b2Body_SetTransform(id, {x, y}, b2Body_GetRotation(id)): move, keep the rotation.
B2X_API void b2x_Body_SetPosition( int32_t index1, int32_t rev, float x, float y )
{
	b2BodyId id = BodyId( index1, rev );
	b2Rot rotation = b2Body_GetRotation( id );
	b2Body_SetTransform( id, b2Vec2{ x, y }, rotation );
}

// b2Body_SetTransform(id, b2Body_GetPosition(id), b2MakeRot(angle)): turn, keep the position.
B2X_API void b2x_Body_SetAngle( int32_t index1, int32_t rev, float angle )
{
	b2BodyId id = BodyId( index1, rev );
	b2Vec2 position = b2Body_GetPosition( id );
	b2Rot rotation = b2MakeRot( angle );
	b2Body_SetTransform( id, position, rotation );
}

B2X_API void b2x_Body_GetPose( int32_t index1, int32_t rev, b2xPose* out )
{
	b2BodyId id = BodyId( index1, rev );
	b2Vec2 p = b2Body_GetPosition( id );
	b2Rot q = b2Body_GetRotation( id );
	out->x = p.x;
	out->y = p.y;
	out->c = q.c;
	out->s = q.s;
	out->angle = b2Rot_GetAngle( q );
}

B2X_API void b2x_Body_GetMotion( int32_t index1, int32_t rev, b2xMotion* out )
{
	b2BodyId id = BodyId( index1, rev );
	out->awake = b2Body_IsAwake( id ) ? 1 : 0;
	b2Vec2 v = b2Body_GetLinearVelocity( id );
	out->vx = v.x;
	out->vy = v.y;
	out->w = b2Body_GetAngularVelocity( id );
	out->linearDamping = b2Body_GetLinearDamping( id );
	out->angularDamping = b2Body_GetAngularDamping( id );
	b2Vec2 center = b2Body_GetLocalCenterOfMass( id );
	out->localCenterX = center.x;
	out->localCenterY = center.y;
	out->mass = b2Body_GetMass( id );
	out->gravityScale = b2Body_GetGravityScale( id );
}
